use fast_image_resize as fir;
use image::ImageDecoder;
use notify::{event::ModifyKind, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rayon::{prelude::*, ThreadPool, ThreadPoolBuilder};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    hash::{Hash, Hasher},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, LazyLock, Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{http, Emitter, Manager, State};
use walkdir::{DirEntry, WalkDir};

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "tif", "tiff", "webp", "dng", "raf", "cr3", "cr2", "nef",
    "arw", "orf", "rw2",
];
const GRID_THUMBNAIL_EDGE: u32 = 560;
const DETAIL_THUMBNAIL_EDGE: u32 = 1600;
const MANIFEST_SCHEMA_VERSION: u32 = 4;
const THUMBNAIL_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PREVIEW_SOURCE_LIMIT: usize = 256;
const SCAN_BATCH_SIZE: usize = 48;
static THUMBNAIL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static PREVIEW_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static THUMBNAIL_PRUNE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static SCAN_POOL: LazyLock<ThreadPool> = LazyLock::new(|| {
    ThreadPoolBuilder::new()
        .num_threads(worker_count(6))
        .thread_name(|index| format!("cadris-scan-{index}"))
        .build()
        .expect("建立 Cadris 掃描工作池失敗")
});
static THUMBNAIL_POOL: LazyLock<ThreadPool> = LazyLock::new(|| {
    ThreadPoolBuilder::new()
        .num_threads(worker_count(4))
        .thread_name(|index| format!("cadris-thumbnail-{index}"))
        .build()
        .expect("建立 Cadris 縮圖工作池失敗")
});

#[derive(Clone, Copy)]
enum ThumbnailVariant {
    Grid,
    Detail,
    Original,
}

impl ThumbnailVariant {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "grid" => Ok(Self::Grid),
            "detail" => Ok(Self::Detail),
            "original" => Ok(Self::Original),
            _ => Err("不支援的縮圖尺寸".into()),
        }
    }

    fn edge(self) -> Option<u32> {
        match self {
            Self::Grid => Some(GRID_THUMBNAIL_EDGE),
            Self::Detail => Some(DETAIL_THUMBNAIL_EDGE),
            Self::Original => None,
        }
    }

    fn jpeg_quality(self) -> u8 {
        match self {
            Self::Grid => 76,
            Self::Detail => 84,
            Self::Original => 96,
        }
    }

    fn cache_key(self) -> &'static str {
        match self {
            Self::Grid => "grid-v1",
            Self::Detail => "detail-v1",
            Self::Original => "original-v1",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Photo {
    path: String,
    relative_path: String,
    name: String,
    extension: String,
    size: u64,
    modified_at: u64,
    camera: Option<String>,
    lens: Option<String>,
    captured_at: Option<String>,
    exposure: Option<String>,
    focal_length: Option<String>,
    exposure_compensation: Option<String>,
    dimensions: Option<String>,
    shooting: Option<String>,
    orientation: Option<String>,
    decision: String,
    rating: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DecisionSaveResult {
    native_synced: bool,
    sync_message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchDecisionSaveResult {
    native_synced: usize,
    pending_native_sync: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryChange {
    root: String,
    paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanUpdate {
    root: String,
    phase: String,
    processed: usize,
    total: usize,
    photos: Vec<Photo>,
}

#[derive(Clone)]
struct PreviewSource {
    path: PathBuf,
    mime: &'static str,
}

#[derive(Default)]
struct PreviewState {
    entries: Mutex<PreviewEntries>,
}

#[derive(Default)]
struct PreviewEntries {
    sources: HashMap<String, PreviewSource>,
    order: VecDeque<String>,
}

#[derive(Clone)]
struct IndexedPhoto {
    name: String,
    extension: String,
    size: u64,
    modified_at: u64,
    camera: Option<String>,
    lens: Option<String>,
    captured_at: Option<String>,
    exposure: Option<String>,
    focal_length: Option<String>,
    exposure_compensation: Option<String>,
    dimensions: Option<String>,
    shooting: Option<String>,
    orientation: Option<String>,
    fingerprint: Option<String>,
}

#[derive(Clone)]
struct ScanCandidate {
    path: PathBuf,
    relative_path: String,
    size: u64,
    modified_at: u64,
}

#[derive(Default)]
struct LibraryWatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

fn worker_count(maximum: usize) -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(2)
        .clamp(2, maximum)
}

fn image_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(extension)
}

fn modified_at(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn file_fingerprint(path: &Path, size: u64) -> Option<String> {
    const SAMPLE_BYTES: usize = 64 * 1024;
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());
    let mut head = vec![0; SAMPLE_BYTES.min(size as usize)];
    file.read_exact(&mut head).ok()?;
    hasher.update(&head);
    if size > SAMPLE_BYTES as u64 {
        let tail_size = SAMPLE_BYTES.min(size as usize);
        file.seek(SeekFrom::End(-(tail_size as i64))).ok()?;
        let mut tail = vec![0; tail_size];
        file.read_exact(&mut tail).ok()?;
        hasher.update(&tail);
    }
    Some(hasher.finalize().to_hex().to_string())
}

#[derive(Default)]
struct PhotoExif {
    camera: Option<String>,
    lens: Option<String>,
    captured_at: Option<String>,
    exposure: Option<String>,
    focal_length: Option<String>,
    exposure_compensation: Option<String>,
    dimensions: Option<String>,
    shooting: Option<String>,
    orientation: Option<String>,
}

fn metadata_value(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    exif.get_field(tag, exif::In::PRIMARY)
        .map(|field| field.display_value().with_unit(exif).to_string())
        .filter(|value| !value.trim().is_empty())
}

fn first_metadata_value(exif: &exif::Exif, tags: &[exif::Tag]) -> Option<String> {
    tags.iter().find_map(|tag| metadata_value(exif, *tag))
}

fn join_metadata_values(values: Vec<Option<String>>, separator: &str) -> Option<String> {
    let mut distinct = Vec::new();
    for value in values.into_iter().flatten() {
        if !distinct
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
        {
            distinct.push(value);
        }
    }
    (!distinct.is_empty()).then(|| distinct.join(separator))
}

fn read_photo_metadata(path: &Path) -> PhotoExif {
    let Ok(file) = fs::File::open(path) else {
        return PhotoExif::default();
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return PhotoExif::default();
    };
    let aperture = first_metadata_value(&exif, &[exif::Tag::FNumber, exif::Tag::ApertureValue]);
    let shutter = first_metadata_value(
        &exif,
        &[exif::Tag::ExposureTime, exif::Tag::ShutterSpeedValue],
    );
    let iso = first_metadata_value(
        &exif,
        &[
            exif::Tag::PhotographicSensitivity,
            exif::Tag::ISOSpeed,
            exif::Tag::RecommendedExposureIndex,
        ],
    )
    .map(|value| format!("ISO {value}"));
    let focal_length = join_metadata_values(
        vec![
            metadata_value(&exif, exif::Tag::FocalLength),
            metadata_value(&exif, exif::Tag::FocalLengthIn35mmFilm)
                .map(|value| format!("{value}（等效）")),
        ],
        " · ",
    );
    let exposure_compensation = metadata_value(&exif, exif::Tag::ExposureBiasValue);
    let dimensions = join_metadata_values(
        vec![
            first_metadata_value(&exif, &[exif::Tag::PixelXDimension, exif::Tag::ImageWidth]),
            first_metadata_value(&exif, &[exif::Tag::PixelYDimension, exif::Tag::ImageLength]),
        ],
        " × ",
    );
    PhotoExif {
        camera: join_metadata_values(
            vec![
                metadata_value(&exif, exif::Tag::Make),
                metadata_value(&exif, exif::Tag::Model),
            ],
            " ",
        ),
        lens: join_metadata_values(
            vec![
                metadata_value(&exif, exif::Tag::LensMake),
                first_metadata_value(&exif, &[exif::Tag::LensModel, exif::Tag::LensSpecification]),
            ],
            " ",
        ),
        captured_at: first_metadata_value(
            &exif,
            &[
                exif::Tag::DateTimeOriginal,
                exif::Tag::DateTimeDigitized,
                exif::Tag::DateTime,
            ],
        ),
        exposure: join_metadata_values(
            vec![
                aperture,
                shutter,
                iso,
                focal_length.clone().map(|value| format!("焦段 {value}")),
                exposure_compensation
                    .clone()
                    .map(|value| format!("補償 {value}")),
            ],
            " · ",
        ),
        focal_length,
        exposure_compensation,
        dimensions,
        shooting: join_metadata_values(
            vec![
                metadata_value(&exif, exif::Tag::ExposureProgram),
                metadata_value(&exif, exif::Tag::ExposureMode),
                metadata_value(&exif, exif::Tag::MeteringMode),
                metadata_value(&exif, exif::Tag::WhiteBalance),
            ],
            " · ",
        ),
        orientation: metadata_value(&exif, exif::Tag::Orientation),
    }
}

#[cfg(target_os = "macos")]
fn sync_native_decision(path: &Path, decision: &str) -> Result<bool, String> {
    const ATTRIBUTE: &str = "com.apple.metadata:_kMDItemUserTags";
    let existing = xattr::get(path, ATTRIBUTE)
        .map_err(|error| format!("無法讀取 Finder 標籤：{error}"))?
        .and_then(|bytes| plist::from_bytes::<Vec<String>>(&bytes).ok())
        .unwrap_or_default();
    let mut tags: Vec<String> = existing
        .into_iter()
        .filter(|tag| {
            let name = tag.split('\n').next().unwrap_or(tag);
            name != "Cadris: Keep" && name != "Cadris: Reject"
        })
        .collect();
    match decision {
        "keep" => tags.push("Cadris: Keep\n2".into()),
        "reject" => tags.push("Cadris: Reject\n6".into()),
        _ => {}
    }
    let mut bytes = Vec::new();
    plist::to_writer_binary(&mut bytes, &tags)
        .map_err(|error| format!("無法編碼 Finder 標籤：{error}"))?;
    xattr::set(path, ATTRIBUTE, &bytes)
        .map_err(|error| format!("無法寫入 Finder 標籤：{error}"))?;
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
fn sync_native_decision(_: &Path, _: &str) -> Result<bool, String> {
    Ok(false)
}

fn open_manifest(root: &Path) -> Result<Connection, String> {
    let state_dir = root.join(".cadris");
    fs::create_dir_all(&state_dir).map_err(|error| format!("無法建立 Cadris 圖庫資料：{error}"))?;
    let connection = Connection::open(state_dir.join("manifest.sqlite"))
        .map_err(|error| format!("無法開啟 Cadris 圖庫資料：{error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 3000;",
        )
        .map_err(|error| format!("無法設定 Cadris 圖庫資料：{error}"))?;
    let current_version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("無法讀取 Cadris 圖庫版本：{error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS decisions (
                relative_path TEXT PRIMARY KEY NOT NULL,
                decision TEXT NOT NULL DEFAULT 'unreviewed',
                rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS native_sync_queue (
                relative_path TEXT PRIMARY KEY NOT NULL,
                decision TEXT NOT NULL,
                queued_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS library_photos (
                relative_path TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                extension TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                camera TEXT,
                lens TEXT,
                captured_at TEXT,
                exposure TEXT,
                focal_length TEXT,
                exposure_compensation TEXT,
                dimensions TEXT,
                shooting TEXT,
                orientation TEXT,
                fingerprint TEXT,
                indexed_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_photos_captured_at ON library_photos(captured_at);
            CREATE INDEX IF NOT EXISTS library_photos_modified_at ON library_photos(modified_at);
            CREATE VIRTUAL TABLE IF NOT EXISTS photo_search USING fts5(
                relative_path UNINDEXED,
                name,
                camera,
                lens,
                tokenize = 'unicode61 remove_diacritics 2'
            );",
        )
        .map_err(|error| format!("無法初始化 Cadris 圖庫資料：{error}"))?;
    if current_version < 3 {
        for (column, definition) in [
            ("focal_length", "TEXT"),
            ("exposure_compensation", "TEXT"),
            ("dimensions", "TEXT"),
            ("shooting", "TEXT"),
            ("orientation", "TEXT"),
        ] {
            add_manifest_column(&connection, column, definition)?;
        }
    }
    if current_version < 4 {
        add_manifest_column(&connection, "fingerprint", "TEXT")?;
        connection
            .execute(
                "CREATE INDEX IF NOT EXISTS library_photos_fingerprint ON library_photos(fingerprint)",
                [],
            )
            .map_err(|error| format!("無法建立圖庫識別索引：{error}"))?;
    }
    if current_version < MANIFEST_SCHEMA_VERSION {
        connection
            .execute_batch(&format!("PRAGMA user_version = {MANIFEST_SCHEMA_VERSION};"))
            .map_err(|error| format!("無法升級 Cadris 圖庫資料：{error}"))?;
    }
    Ok(connection)
}

fn add_manifest_column(
    connection: &Connection,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(library_photos)")
        .map_err(|error| format!("無法檢查圖庫資料欄位：{error}"))?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("無法讀取圖庫資料欄位：{error}"))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        connection
            .execute_batch(&format!(
                "ALTER TABLE library_photos ADD COLUMN {column} {definition}"
            ))
            .map_err(|error| format!("無法升級圖庫資料欄位：{error}"))?;
    }
    Ok(())
}

fn visible_library_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        Component::CurDir => false,
        _ => true,
    }) {
        return None;
    }
    image_extension(path)?;
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn allow_walk_entry(entry: &DirEntry) -> bool {
    entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
}

fn collect_photos(root: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(allow_walk_entry)
    {
        let entry = entry.map_err(|error| format!("無法讀取資料夾：{error}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.into_path();
        if let Some(relative_path) = visible_library_path(root, &path) {
            files.push((path, relative_path));
        }
    }
    Ok(files)
}

fn library_photo_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("影像路徑必須位於目前圖庫內".into());
    }
    let path = root.join(relative);
    visible_library_path(root, &path).ok_or_else(|| String::from("不是可管理的圖庫影像"))?;
    if !path.is_file() {
        return Err("找不到目前圖庫中的影像".into());
    }
    Ok(path)
}

fn read_decisions(connection: &Connection) -> Result<HashMap<String, (String, u8)>, String> {
    let mut statement = connection
        .prepare("SELECT relative_path, decision, rating FROM decisions")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u8>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut decisions = HashMap::new();
    for row in rows {
        let (path, decision, rating) = row.map_err(|error| error.to_string())?;
        decisions.insert(path, (decision, rating));
    }
    Ok(decisions)
}

fn read_indexed_photos(connection: &Connection) -> Result<HashMap<String, IndexedPhoto>, String> {
    let mut statement = connection
        .prepare(
            "SELECT relative_path, name, extension, size, modified_at, camera, lens, captured_at,
                    exposure, focal_length, exposure_compensation, dimensions, shooting, orientation, fingerprint
             FROM library_photos",
        )
        .map_err(|error| format!("無法讀取既有圖庫索引：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                IndexedPhoto {
                    name: row.get(1)?,
                    extension: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    modified_at: row.get::<_, i64>(4)? as u64,
                    camera: row.get(5)?,
                    lens: row.get(6)?,
                    captured_at: row.get(7)?,
                    exposure: row.get(8)?,
                    focal_length: row.get(9)?,
                    exposure_compensation: row.get(10)?,
                    dimensions: row.get(11)?,
                    shooting: row.get(12)?,
                    orientation: row.get(13)?,
                    fingerprint: row.get(14)?,
                },
            ))
        })
        .map_err(|error| format!("無法讀取既有圖庫索引：{error}"))?;
    rows.map(|row| row.map_err(|error| format!("無法讀取既有圖庫索引：{error}")))
        .collect()
}

fn photo_matches_index(photo: &Photo, indexed: &IndexedPhoto, fingerprint: &str) -> bool {
    photo.name == indexed.name
        && photo.extension == indexed.extension
        && photo.size == indexed.size
        && photo.modified_at == indexed.modified_at
        && photo.camera == indexed.camera
        && photo.lens == indexed.lens
        && photo.captured_at == indexed.captured_at
        && photo.exposure == indexed.exposure
        && photo.focal_length == indexed.focal_length
        && photo.exposure_compensation == indexed.exposure_compensation
        && photo.dimensions == indexed.dimensions
        && photo.shooting == indexed.shooting
        && photo.orientation == indexed.orientation
        && indexed.fingerprint.as_deref() == Some(fingerprint)
}

fn index_photos(
    connection: &mut Connection,
    photos: &[Photo],
    fingerprints: &HashMap<String, String>,
    existing: &HashMap<String, IndexedPhoto>,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("無法開始圖庫索引更新：{error}"))?;
    let current_paths = photos
        .iter()
        .map(|photo| photo.relative_path.as_str())
        .collect::<HashSet<_>>();
    for removed_path in existing
        .keys()
        .filter(|relative_path| !current_paths.contains(relative_path.as_str()))
    {
        transaction
            .execute(
                "DELETE FROM photo_search WHERE relative_path = ?1",
                [removed_path],
            )
            .map_err(|error| format!("無法移除過期搜尋索引：{error}"))?;
        transaction
            .execute(
                "DELETE FROM library_photos WHERE relative_path = ?1",
                [removed_path],
            )
            .map_err(|error| format!("無法移除過期圖庫索引：{error}"))?;
    }
    for photo in photos {
        let fingerprint = fingerprints
            .get(&photo.relative_path)
            .ok_or_else(|| format!("缺少影像識別資料：{}", photo.relative_path))?;
        if existing
            .get(&photo.relative_path)
            .is_some_and(|indexed| photo_matches_index(photo, indexed, fingerprint))
        {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO library_photos(
                    relative_path, name, extension, size, modified_at, camera, lens, captured_at, exposure,
                    focal_length, exposure_compensation, dimensions, shooting, orientation, fingerprint, indexed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, unixepoch())
                ON CONFLICT(relative_path) DO UPDATE SET
                    name = excluded.name, extension = excluded.extension, size = excluded.size,
                    modified_at = excluded.modified_at, camera = excluded.camera, lens = excluded.lens,
                    captured_at = excluded.captured_at, exposure = excluded.exposure,
                    focal_length = excluded.focal_length, exposure_compensation = excluded.exposure_compensation,
                    dimensions = excluded.dimensions, shooting = excluded.shooting,
                    orientation = excluded.orientation, fingerprint = excluded.fingerprint,
                    indexed_at = excluded.indexed_at",
                params![
                    &photo.relative_path,
                    &photo.name,
                    &photo.extension,
                    photo.size as i64,
                    photo.modified_at as i64,
                    &photo.camera,
                    &photo.lens,
                    &photo.captured_at,
                    &photo.exposure,
                    &photo.focal_length,
                    &photo.exposure_compensation,
                    &photo.dimensions,
                    &photo.shooting,
                    &photo.orientation,
                    fingerprint,
                ],
            )
            .map_err(|error| format!("無法寫入圖庫索引：{error}"))?;
        transaction
            .execute(
                "DELETE FROM photo_search WHERE relative_path = ?1",
                [&photo.relative_path],
            )
            .map_err(|error| format!("無法更新搜尋索引：{error}"))?;
        transaction
            .execute(
                "INSERT INTO photo_search(relative_path, name, camera, lens) VALUES (?1, ?2, ?3, ?4)",
                params![&photo.relative_path, &photo.name, &photo.camera, &photo.lens],
            )
            .map_err(|error| format!("無法寫入搜尋索引：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("無法完成圖庫索引更新：{error}"))
}

fn fts_query(value: &str) -> Option<String> {
    let terms = value
        .split_whitespace()
        .map(|term| term.trim_matches('"'))
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

fn search_index(connection: &Connection, query: &str) -> Result<Vec<String>, String> {
    let Some(query) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut statement = connection
        .prepare(
            "SELECT relative_path FROM photo_search
             WHERE photo_search MATCH ?1
             ORDER BY rank
             LIMIT 10000",
        )
        .map_err(|error| format!("無法準備搜尋索引：{error}"))?;
    let rows = statement
        .query_map([query], |row| row.get::<_, String>(0))
        .map_err(|error| format!("無法搜尋圖庫：{error}"))?;
    rows.map(|row| row.map_err(|error| format!("無法讀取搜尋結果：{error}")))
        .collect()
}

fn thumbnail_path(
    root: &Path,
    relative_path: &str,
    size: u64,
    modified_at: u64,
    variant: ThumbnailVariant,
) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    relative_path.hash(&mut hasher);
    size.hash(&mut hasher);
    modified_at.hash(&mut hasher);
    variant.cache_key().hash(&mut hasher);
    root.join(".cadris")
        .join("thumbnails")
        .join(format!("{:016x}.jpg", hasher.finish()))
}

fn thumbnail_dimensions(width: u32, height: u32, edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= edge {
        return (width, height);
    }
    let scale = edge as f64 / longest as f64;
    (
        (width as f64 * scale).round().max(1.0) as u32,
        (height as f64 * scale).round().max(1.0) as u32,
    )
}

fn resize_for_thumbnail(
    decoded: image::DynamicImage,
    variant: ThumbnailVariant,
) -> Result<image::DynamicImage, String> {
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let (thumbnail_width, thumbnail_height) = variant
        .edge()
        .map(|edge| thumbnail_dimensions(width, height, edge))
        .unwrap_or((width, height));
    if (width, height) == (thumbnail_width, thumbnail_height) {
        return Ok(image::DynamicImage::ImageRgba8(rgba));
    }
    let source =
        fir::images::Image::from_vec_u8(width, height, rgba.into_raw(), fir::PixelType::U8x4)
            .map_err(|error| format!("無法準備縮圖像素：{error}"))?;
    let mut target =
        fir::images::Image::new(thumbnail_width, thumbnail_height, fir::PixelType::U8x4);
    let options = fir::ResizeOptions::new()
        .resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Lanczos3));
    fir::Resizer::new()
        .resize(&source, &mut target, &options)
        .map_err(|error| format!("無法縮放縮圖：{error}"))?;
    let image = image::RgbaImage::from_raw(thumbnail_width, thumbnail_height, target.into_vec())
        .ok_or_else(|| "無法建立縮放後的縮圖".to_string())?;
    Ok(image::DynamicImage::ImageRgba8(image))
}

fn temporary_thumbnail_path(cached_path: &Path) -> PathBuf {
    let sequence = THUMBNAIL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stem = cached_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("thumbnail");
    cached_path.with_file_name(format!("{stem}-{}-{sequence}.tmp.jpg", std::process::id()))
}

fn write_jpeg_thumbnail(
    decoded: image::DynamicImage,
    temporary_path: &Path,
    variant: ThumbnailVariant,
) -> Result<bool, String> {
    let thumbnail = resize_for_thumbnail(decoded, variant)?;
    let file =
        fs::File::create(temporary_path).map_err(|error| format!("無法建立縮圖：{error}"))?;
    image::codecs::jpeg::JpegEncoder::new_with_quality(file, variant.jpeg_quality())
        .encode_image(&thumbnail)
        .map_err(|error| format!("無法寫入縮圖：{error}"))?;
    Ok(true)
}

fn create_rust_thumbnail(
    photo_path: &Path,
    temporary_path: &Path,
    variant: ThumbnailVariant,
) -> Result<bool, String> {
    let Ok(reader) = image::ImageReader::open(photo_path) else {
        return Ok(false);
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return Ok(false);
    };
    let Ok(mut decoder) = reader.into_decoder() else {
        return Ok(false);
    };
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let Ok(mut decoded) = image::DynamicImage::from_decoder(decoder) else {
        return Ok(false);
    };
    decoded.apply_orientation(orientation);
    write_jpeg_thumbnail(decoded, temporary_path, variant)
}

#[cfg(target_os = "macos")]
fn create_platform_thumbnail(
    photo_path: &Path,
    temporary_path: &Path,
    variant: ThumbnailVariant,
) -> Result<bool, String> {
    let mut command = Command::new("/usr/bin/sips");
    command.args(["-s", "format", "jpeg"]);
    if let Some(edge) = variant.edge() {
        command.args(["-Z", &edge.to_string()]);
    }
    let output = command
        .arg(photo_path)
        .arg("--out")
        .arg(temporary_path)
        .output()
        .map_err(|error| format!("無法啟動 macOS 影像預覽：{error}"))?;
    if output.status.success() && temporary_path.is_file() {
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(not(target_os = "macos"))]
fn create_platform_thumbnail(_: &Path, _: &Path, _: ThumbnailVariant) -> Result<bool, String> {
    Ok(false)
}

fn valid_thumbnail_cache(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let Ok(reader) = image::ImageReader::open(path) else {
        return false;
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return false;
    };
    reader.decode().is_ok()
}

fn original_image_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn original_image_source(
    root: &Path,
    relative_path: &str,
) -> Result<Option<PreviewSource>, String> {
    let photo_path = library_photo_path(root, relative_path)?;
    let Some(extension) = image_extension(&photo_path) else {
        return Ok(None);
    };
    let Some(mime) = original_image_mime(&extension) else {
        return Ok(None);
    };
    Ok(Some(PreviewSource {
        path: photo_path,
        mime,
    }))
}

fn preview_url(token: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("http://cadris-photo.localhost/{token}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("cadris-photo://localhost/{token}")
    }
}

fn register_preview_source(state: &PreviewState, source: PreviewSource) -> Result<String, String> {
    if !source.path.is_file() {
        return Err("預覽影像已不存在".into());
    }
    let token = format!(
        "{:x}-{:016x}",
        std::process::id(),
        PREVIEW_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "無法更新預覽來源".to_string())?;
    entries.sources.insert(token.clone(), source);
    entries.order.push_back(token.clone());
    while entries.order.len() > PREVIEW_SOURCE_LIMIT {
        if let Some(expired) = entries.order.pop_front() {
            entries.sources.remove(&expired);
        }
    }
    Ok(preview_url(&token))
}

fn preview_source_for_token(state: &PreviewState, token: &str) -> Option<PreviewSource> {
    state.entries.lock().ok()?.sources.get(token).cloned()
}

fn cache_directory(root: &Path) -> PathBuf {
    root.join(".cadris").join("thumbnails")
}

fn prune_thumbnail_cache(root: &Path, protected: Option<&Path>) {
    let cache = cache_directory(root);
    prune_thumbnail_cache_to_limit(&cache, THUMBNAIL_CACHE_LIMIT_BYTES, protected);
}

fn prune_thumbnail_cache_to_limit(cache: &Path, limit_bytes: u64, protected: Option<&Path>) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let protected = protected.map(Path::to_path_buf);
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            (metadata.is_file() && path.extension().is_some_and(|extension| extension == "jpg"))
                .then_some((path, metadata.len(), metadata.modified().ok()))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    if total <= limit_bytes {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= limit_bytes {
            break;
        }
        if protected.as_ref().is_some_and(|value| value == &path) {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn build_thumbnail(
    root: &Path,
    relative_path: &str,
    variant: ThumbnailVariant,
) -> Result<Option<String>, String> {
    let photo_path = library_photo_path(root, relative_path)?;
    let metadata =
        fs::metadata(&photo_path).map_err(|error| format!("無法讀取影像資料：{error}"))?;
    let cached_path = thumbnail_path(
        root,
        relative_path,
        metadata.len(),
        modified_at(&metadata),
        variant,
    );
    if valid_thumbnail_cache(&cached_path) {
        if THUMBNAIL_PRUNE_SEQUENCE
            .fetch_add(1, Ordering::Relaxed)
            .is_multiple_of(24)
        {
            prune_thumbnail_cache(root, Some(&cached_path));
        }
        return Ok(Some(cached_path.to_string_lossy().into()));
    }
    if cached_path.exists() {
        let _ = fs::remove_file(&cached_path);
    }
    let parent = cached_path
        .parent()
        .ok_or_else(|| "無法建立縮圖快取位置".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("無法建立縮圖快取：{error}"))?;
    let temporary_path = temporary_thumbnail_path(&cached_path);
    let created = create_rust_thumbnail(&photo_path, &temporary_path, variant)?
        || create_platform_thumbnail(&photo_path, &temporary_path, variant)?;
    if !created {
        return Ok(None);
    }
    fs::rename(&temporary_path, &cached_path)
        .map_err(|error| format!("無法完成縮圖快取：{error}"))?;
    if THUMBNAIL_PRUNE_SEQUENCE
        .fetch_add(1, Ordering::Relaxed)
        .is_multiple_of(24)
    {
        prune_thumbnail_cache(root, Some(&cached_path));
    }
    Ok(Some(cached_path.to_string_lossy().into()))
}

#[tauri::command]
fn thumbnail_for(
    preview_state: State<'_, PreviewState>,
    root: String,
    relative_path: String,
    variant: String,
) -> Result<Option<String>, String> {
    let root = PathBuf::from(root);
    let variant = ThumbnailVariant::parse(&variant)?;
    THUMBNAIL_POOL.install(|| {
        if matches!(variant, ThumbnailVariant::Original) {
            if let Some(source) = original_image_source(&root, &relative_path)? {
                return register_preview_source(&preview_state, source).map(Some);
            }
        }
        let Some(path) = build_thumbnail(&root, &relative_path, variant)? else {
            return Ok(None);
        };
        register_preview_source(
            &preview_state,
            PreviewSource {
                path: PathBuf::from(path),
                mime: "image/jpeg",
            },
        )
        .map(Some)
    })
}

#[tauri::command]
fn scan_library(app: tauri::AppHandle, root: String) -> Result<Vec<Photo>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("選取的位置不是資料夾".into());
    }
    let mut connection = open_manifest(&root)?;
    let files = collect_photos(&root)?;
    let candidates = files
        .into_iter()
        .filter_map(|(path, relative_path)| {
            let metadata = fs::metadata(&path).ok()?;
            Some(ScanCandidate {
                path,
                relative_path,
                size: metadata.len(),
                modified_at: modified_at(&metadata),
            })
        })
        .collect::<Vec<_>>();
    let root_display = root.to_string_lossy().into_owned();
    emit_scan_update(
        &app,
        &root_display,
        "讀取圖庫索引",
        0,
        candidates.len(),
        Vec::new(),
    );
    let indexed = read_indexed_photos(&connection)?;
    let current_paths = candidates
        .iter()
        .map(|candidate| candidate.relative_path.clone())
        .collect::<HashSet<_>>();
    let refresh_paths = candidates
        .iter()
        .filter(|candidate| {
            indexed.get(&candidate.relative_path).is_none_or(|photo| {
                photo.size != candidate.size
                    || photo.modified_at != candidate.modified_at
                    || photo.fingerprint.is_none()
            })
        })
        .map(|candidate| candidate.relative_path.clone())
        .collect::<HashSet<_>>();
    let fingerprints = SCAN_POOL.install(|| {
        candidates
            .par_iter()
            .map(|candidate| {
                let fingerprint = indexed
                    .get(&candidate.relative_path)
                    .and_then(|photo| {
                        (!refresh_paths.contains(&candidate.relative_path))
                            .then(|| photo.fingerprint.clone())
                            .flatten()
                    })
                    .or_else(|| file_fingerprint(&candidate.path, candidate.size))
                    .unwrap_or_else(|| fallback_fingerprint(candidate));
                (candidate.relative_path.clone(), fingerprint)
            })
            .collect::<HashMap<_, _>>()
    });
    migrate_renamed_decisions(&connection, &indexed, &current_paths, &fingerprints)?;
    let _ = flush_native_sync_queue(&root, &connection);
    let decisions = Arc::new(read_decisions(&connection)?);

    let cached = candidates
        .iter()
        .filter(|candidate| !refresh_paths.contains(&candidate.relative_path))
        .filter_map(|candidate| {
            indexed
                .get(&candidate.relative_path)
                .map(|photo| photo_from_index(&root, candidate, photo, &decisions))
        })
        .collect::<Vec<_>>();
    for batch in cached.chunks(SCAN_BATCH_SIZE) {
        emit_scan_update(
            &app,
            &root_display,
            "載入既有照片",
            cached.len(),
            candidates.len(),
            batch.to_vec(),
        );
    }

    let completed = Arc::new(AtomicU64::new(cached.len() as u64));
    let pending_batch = Arc::new(Mutex::new(Vec::with_capacity(SCAN_BATCH_SIZE)));
    let photos_from_disk = SCAN_POOL.install(|| {
        candidates
            .par_iter()
            .filter(|candidate| refresh_paths.contains(&candidate.relative_path))
            .filter_map(|candidate| {
                let photo = photo_from_disk(candidate, &decisions);
                let processed = completed.fetch_add(1, Ordering::Relaxed) as usize + 1;
                let mut batch = pending_batch.lock().ok()?;
                batch.push(photo.clone());
                if batch.len() >= SCAN_BATCH_SIZE {
                    emit_scan_update(
                        &app,
                        &root_display,
                        "解析新增與變動照片",
                        processed,
                        candidates.len(),
                        std::mem::take(&mut *batch),
                    );
                }
                Some(photo)
            })
            .collect::<Vec<_>>()
    });
    if let Ok(mut batch) = pending_batch.lock() {
        if !batch.is_empty() {
            emit_scan_update(
                &app,
                &root_display,
                "解析新增與變動照片",
                candidates.len(),
                candidates.len(),
                std::mem::take(&mut *batch),
            );
        }
    }
    let mut photos = cached;
    photos.extend(photos_from_disk);
    photos.sort_by_key(|photo| photo.name.to_lowercase());
    index_photos(&mut connection, &photos, &fingerprints, &indexed)?;
    emit_scan_update(
        &app,
        &root_display,
        "完成",
        photos.len(),
        photos.len(),
        Vec::new(),
    );
    Ok(photos)
}

fn emit_scan_update(
    app: &tauri::AppHandle,
    root: &str,
    phase: &str,
    processed: usize,
    total: usize,
    photos: Vec<Photo>,
) {
    let _ = app.emit(
        "cadris://scan-progress",
        ScanUpdate {
            root: root.into(),
            phase: phase.into(),
            processed,
            total,
            photos,
        },
    );
}

fn fallback_fingerprint(candidate: &ScanCandidate) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(candidate.relative_path.as_bytes());
    hasher.update(&candidate.size.to_le_bytes());
    hasher.update(&candidate.modified_at.to_le_bytes());
    format!("metadata:{}", hasher.finalize().to_hex())
}

fn photo_from_disk(candidate: &ScanCandidate, decisions: &HashMap<String, (String, u8)>) -> Photo {
    let exif = read_photo_metadata(&candidate.path);
    let (decision, rating) = decisions
        .get(&candidate.relative_path)
        .cloned()
        .unwrap_or_else(|| ("unreviewed".into(), 0));
    Photo {
        name: candidate
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("未命名影像")
            .into(),
        extension: candidate
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_uppercase(),
        path: candidate.path.to_string_lossy().into(),
        relative_path: candidate.relative_path.clone(),
        size: candidate.size,
        modified_at: candidate.modified_at,
        camera: exif.camera,
        lens: exif.lens,
        captured_at: exif.captured_at,
        exposure: exif.exposure,
        focal_length: exif.focal_length,
        exposure_compensation: exif.exposure_compensation,
        dimensions: exif.dimensions,
        shooting: exif.shooting,
        orientation: exif.orientation,
        decision,
        rating,
    }
}

fn photo_from_index(
    root: &Path,
    candidate: &ScanCandidate,
    indexed: &IndexedPhoto,
    decisions: &HashMap<String, (String, u8)>,
) -> Photo {
    let (decision, rating) = decisions
        .get(&candidate.relative_path)
        .cloned()
        .unwrap_or_else(|| ("unreviewed".into(), 0));
    Photo {
        path: root.join(&candidate.relative_path).to_string_lossy().into(),
        relative_path: candidate.relative_path.clone(),
        name: indexed.name.clone(),
        extension: indexed.extension.clone(),
        size: candidate.size,
        modified_at: candidate.modified_at,
        camera: indexed.camera.clone(),
        lens: indexed.lens.clone(),
        captured_at: indexed.captured_at.clone(),
        exposure: indexed.exposure.clone(),
        focal_length: indexed.focal_length.clone(),
        exposure_compensation: indexed.exposure_compensation.clone(),
        dimensions: indexed.dimensions.clone(),
        shooting: indexed.shooting.clone(),
        orientation: indexed.orientation.clone(),
        decision,
        rating,
    }
}

fn migrate_renamed_decisions(
    connection: &Connection,
    indexed: &HashMap<String, IndexedPhoto>,
    current_paths: &HashSet<String>,
    fingerprints: &HashMap<String, String>,
) -> Result<(), String> {
    let mut missing_by_fingerprint = HashMap::<&str, Vec<&str>>::new();
    for (relative_path, photo) in indexed {
        if !current_paths.contains(relative_path) {
            if let Some(fingerprint) = photo.fingerprint.as_deref() {
                missing_by_fingerprint
                    .entry(fingerprint)
                    .or_default()
                    .push(relative_path);
            }
        }
    }
    let mut new_by_fingerprint = HashMap::<&str, Vec<&str>>::new();
    for (relative_path, fingerprint) in fingerprints {
        if !indexed.contains_key(relative_path) {
            new_by_fingerprint
                .entry(fingerprint)
                .or_default()
                .push(relative_path);
        }
    }
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("無法開始決定遷移：{error}"))?;
    for (fingerprint, old_paths) in missing_by_fingerprint {
        let Some(new_paths) = new_by_fingerprint.get(fingerprint) else {
            continue;
        };
        if old_paths.len() == 1 && new_paths.len() == 1 {
            transaction
                .execute(
                    "UPDATE decisions SET relative_path = ?1, updated_at = unixepoch()
                     WHERE relative_path = ?2
                       AND NOT EXISTS (SELECT 1 FROM decisions WHERE relative_path = ?1)",
                    params![new_paths[0], old_paths[0]],
                )
                .map_err(|error| format!("無法保留重新命名照片的決定：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("無法完成決定遷移：{error}"))
}

#[tauri::command]
fn search_library(root: String, query: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root);
    let connection = open_manifest(&root)?;
    search_index(&connection, &query)
}

fn watchable_change(root: &Path, event: &Event) -> Vec<String> {
    let changes_photo_content = matches!(
        event.kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
    );
    if !changes_photo_content {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter_map(|path| visible_library_path(root, path))
        .collect()
}

#[tauri::command]
fn watch_library(
    app: tauri::AppHandle,
    watch_state: State<'_, LibraryWatchState>,
    root: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("選取的位置不是資料夾".into());
    }
    let (change_sender, change_receiver) = mpsc::channel::<Vec<String>>();
    let callback_root = root_path.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(event) = event {
            let paths = watchable_change(&callback_root, &event);
            if !paths.is_empty() {
                let _ = change_sender.send(paths);
            }
        }
    })
    .map_err(|error| format!("無法啟用圖庫監看：{error}"))?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|error| format!("無法監看圖庫資料夾：{error}"))?;
    {
        let mut active = watch_state
            .watcher
            .lock()
            .map_err(|_| "無法更新圖庫監看狀態".to_string())?;
        *active = Some(watcher);
    }
    let event_root = root_path.to_string_lossy().into_owned();
    thread::spawn(move || {
        let mut pending = BTreeSet::new();
        loop {
            match change_receiver.recv_timeout(Duration::from_millis(700)) {
                Ok(paths) => pending.extend(paths),
                Err(mpsc::RecvTimeoutError::Timeout) if !pending.is_empty() => {
                    let paths = std::mem::take(&mut pending).into_iter().collect();
                    let _ = app.emit(
                        "cadris://library-changed",
                        LibraryChange {
                            root: event_root.clone(),
                            paths,
                        },
                    );
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn save_decision(
    root: String,
    relative_path: String,
    decision: String,
) -> Result<DecisionSaveResult, String> {
    let result = save_decisions_batch(root, vec![relative_path], decision)?;
    Ok(DecisionSaveResult {
        native_synced: result.native_synced == 1,
        sync_message: (result.pending_native_sync > 0)
            .then_some("Cadris 決定已保存；Finder 標籤會在下次可寫入時自動重試。".into()),
    })
}

#[tauri::command]
fn save_decisions_batch(
    root: String,
    relative_paths: Vec<String>,
    decision: String,
) -> Result<BatchDecisionSaveResult, String> {
    if !matches!(decision.as_str(), "unreviewed" | "keep" | "reject") {
        return Err("無效的旗標狀態".into());
    }
    let root_path = PathBuf::from(&root);
    let relative_paths = unique_library_paths(&root_path, relative_paths)?;
    if relative_paths.is_empty() {
        return Ok(BatchDecisionSaveResult {
            native_synced: 0,
            pending_native_sync: 0,
        });
    }
    let mut connection = open_manifest(&root_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("無法開始批次儲存旗標：{error}"))?;
    for relative_path in &relative_paths {
        transaction
            .execute(
                "INSERT INTO decisions(relative_path, decision, rating, updated_at) VALUES (?1, ?2, 0, unixepoch())
                 ON CONFLICT(relative_path) DO UPDATE SET decision = excluded.decision, updated_at = unixepoch()",
                params![relative_path, decision],
            )
            .map_err(|error| format!("無法儲存旗標：{error}"))?;
        if cfg!(target_os = "macos") {
            transaction
                .execute(
                    "INSERT INTO native_sync_queue(relative_path, decision, queued_at, attempts, last_error)
                     VALUES (?1, ?2, unixepoch(), 0, NULL)
                     ON CONFLICT(relative_path) DO UPDATE SET
                        decision = excluded.decision, queued_at = excluded.queued_at,
                        attempts = 0, last_error = NULL",
                    params![relative_path, decision],
                )
                .map_err(|error| format!("無法排入 Finder 標籤同步：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("無法完成批次儲存旗標：{error}"))?;
    let (native_synced, pending_native_sync) = flush_native_sync_queue(&root_path, &connection)?;
    Ok(BatchDecisionSaveResult {
        native_synced,
        pending_native_sync,
    })
}

#[tauri::command]
fn save_rating(root: String, relative_path: String, rating: u8) -> Result<(), String> {
    save_ratings_batch(root, vec![relative_path], rating)
}

#[tauri::command]
fn save_ratings_batch(root: String, relative_paths: Vec<String>, rating: u8) -> Result<(), String> {
    if rating > 5 {
        return Err("星等必須介於 0 到 5".into());
    }
    let root_path = PathBuf::from(root);
    let relative_paths = unique_library_paths(&root_path, relative_paths)?;
    let mut connection = open_manifest(&root_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("無法開始批次儲存星等：{error}"))?;
    for relative_path in &relative_paths {
        transaction
            .execute(
                "INSERT INTO decisions(relative_path, decision, rating, updated_at) VALUES (?1, 'unreviewed', ?2, unixepoch())
                 ON CONFLICT(relative_path) DO UPDATE SET rating = excluded.rating, updated_at = unixepoch()",
                params![relative_path, rating],
            )
            .map_err(|error| format!("無法儲存星等：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("無法完成批次儲存星等：{error}"))?;
    Ok(())
}

fn unique_library_paths(root: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut unique = BTreeSet::new();
    for path in paths {
        library_photo_path(root, &path)?;
        unique.insert(path);
    }
    Ok(unique.into_iter().collect())
}

fn flush_native_sync_queue(root: &Path, connection: &Connection) -> Result<(usize, usize), String> {
    if !cfg!(target_os = "macos") {
        return Ok((0, 0));
    }
    let mut statement = connection
        .prepare(
            "SELECT relative_path, decision FROM native_sync_queue ORDER BY queued_at LIMIT 256",
        )
        .map_err(|error| format!("無法讀取 Finder 標籤同步佇列：{error}"))?;
    let queued = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("無法讀取 Finder 標籤同步佇列：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("無法讀取 Finder 標籤同步佇列：{error}"))?;
    let mut synced = 0;
    for (relative_path, decision) in queued {
        match library_photo_path(root, &relative_path)
            .and_then(|path| sync_native_decision(&path, &decision))
        {
            Ok(true) => {
                connection
                    .execute(
                        "DELETE FROM native_sync_queue WHERE relative_path = ?1",
                        [&relative_path],
                    )
                    .map_err(|error| format!("無法更新 Finder 標籤同步佇列：{error}"))?;
                synced += 1;
            }
            Ok(false) => {}
            Err(error) => {
                connection
                    .execute(
                        "UPDATE native_sync_queue SET attempts = attempts + 1, last_error = ?2 WHERE relative_path = ?1",
                        params![relative_path, error],
                    )
                    .map_err(|error| format!("無法更新 Finder 標籤同步佇列：{error}"))?;
            }
        }
    }
    let pending = connection
        .query_row("SELECT COUNT(*) FROM native_sync_queue", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| format!("無法統計 Finder 標籤同步佇列：{error}"))?
        as usize;
    Ok((synced, pending))
}

fn preview_response(
    status: http::StatusCode,
    mime: &'static str,
    body: Vec<u8>,
) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, mime)
        .header(http::header::CACHE_CONTROL, "private, max-age=300")
        .body(body)
        .expect("建立影像預覽回應失敗")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LibraryWatchState::default())
        .manage(PreviewState::default())
        .register_asynchronous_uri_scheme_protocol("cadris-photo", |context, request, responder| {
            let token = request.uri().path().trim_start_matches('/').to_string();
            let source = preview_source_for_token(
                context.app_handle().state::<PreviewState>().inner(),
                &token,
            );
            thread::spawn(move || match source {
                Some(source) => match fs::read(&source.path) {
                    Ok(bytes) => responder.respond(preview_response(
                        http::StatusCode::OK,
                        source.mime,
                        bytes,
                    )),
                    Err(_) => responder.respond(preview_response(
                        http::StatusCode::NOT_FOUND,
                        "text/plain; charset=utf-8",
                        "影像已不存在".as_bytes().to_vec(),
                    )),
                },
                None => responder.respond(preview_response(
                    http::StatusCode::NOT_FOUND,
                    "text/plain; charset=utf-8",
                    "找不到受控預覽來源".as_bytes().to_vec(),
                )),
            });
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            search_library,
            thumbnail_for,
            watch_library,
            save_decision,
            save_decisions_batch,
            save_rating,
            save_ratings_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cadris-{label}-{}", std::process::id()))
    }

    fn test_photo(directory: &Path, relative_path: &str) -> Photo {
        Photo {
            path: directory.join(relative_path).to_string_lossy().into(),
            relative_path: relative_path.into(),
            name: relative_path.into(),
            extension: relative_path
                .rsplit('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase(),
            size: 42,
            modified_at: 1,
            camera: Some("FUJIFILM X-M5".into()),
            lens: Some("XF 23mmF2".into()),
            captured_at: None,
            exposure: None,
            focal_length: None,
            exposure_compensation: None,
            dimensions: None,
            shooting: None,
            orientation: None,
            decision: "unreviewed".into(),
            rating: 0,
        }
    }

    #[test]
    fn manifest_uses_wal_and_indexes_photo_search() {
        let directory = test_directory("manifest-test");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let mut connection = open_manifest(&directory).unwrap();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        let photo = test_photo(&directory, "RAF0001.raf");
        let fingerprints =
            HashMap::from([(photo.relative_path.clone(), "test-fingerprint".into())]);
        index_photos(&mut connection, &[photo], &fingerprints, &HashMap::new()).unwrap();
        assert_eq!(
            search_index(&connection, "Fujifilm 23mm").unwrap(),
            ["RAF0001.raf"]
        );
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn watcher_ignores_cadris_state_and_reports_photo_data_changes() {
        let directory = test_directory("watch-test");
        let photo = directory.join("image.jpg");
        let state = directory.join(".cadris").join("manifest.sqlite");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any)),
            paths: vec![photo.clone(), state],
            attrs: Default::default(),
        };
        assert_eq!(watchable_change(&directory, &event), vec!["image.jpg"]);
        assert!(library_photo_path(&directory, "../outside.jpg").is_err());
    }

    #[test]
    fn thumbnail_cache_uses_native_preview_urls_and_reuses_files() {
        let directory = test_directory("thumbnail-test");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("photo.png");
        image::RgbImage::from_pixel(2_000, 1_000, image::Rgb([45, 110, 180]))
            .save(&source)
            .unwrap();

        let first = build_thumbnail(&directory, "photo.png", ThumbnailVariant::Grid)
            .unwrap()
            .unwrap();
        let second = build_thumbnail(&directory, "photo.png", ThumbnailVariant::Grid)
            .unwrap()
            .unwrap();
        let detail = build_thumbnail(&directory, "photo.png", ThumbnailVariant::Detail)
            .unwrap()
            .unwrap();
        assert_eq!(first, second);
        let grid_image = image::open(&first).unwrap();
        assert_eq!((grid_image.width(), grid_image.height()), (560, 280));
        let detail_image = image::open(&detail).unwrap();
        assert_eq!((detail_image.width(), detail_image.height()), (1_600, 800));
        let original = original_image_source(&directory, "photo.png")
            .unwrap()
            .unwrap();
        assert_eq!(original.path, source);
        let previews = PreviewState::default();
        let url = register_preview_source(&previews, original).unwrap();
        assert!(!url.starts_with("data:"));
        let token = url.rsplit('/').next().unwrap();
        assert_eq!(
            preview_source_for_token(&previews, token).unwrap().mime,
            "image/png"
        );
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn index_updates_only_changed_paths_and_removes_absent_photos() {
        let directory = test_directory("incremental-index-test");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let mut connection = open_manifest(&directory).unwrap();
        let first = test_photo(&directory, "first.jpg");
        let second = test_photo(&directory, "second.jpg");
        let fingerprints = HashMap::from([
            (first.relative_path.clone(), "first".into()),
            (second.relative_path.clone(), "second".into()),
        ]);
        index_photos(
            &mut connection,
            &[first.clone(), second],
            &fingerprints,
            &HashMap::new(),
        )
        .unwrap();
        let existing = read_indexed_photos(&connection).unwrap();
        index_photos(&mut connection, &[first], &fingerprints, &existing).unwrap();
        assert_eq!(
            search_index(&connection, "second").unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(search_index(&connection, "first").unwrap(), ["first.jpg"]);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn renamed_photo_moves_its_saved_decision_when_identity_is_unambiguous() {
        let directory = test_directory("rename-decision-test");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let mut connection = open_manifest(&directory).unwrap();
        let old = test_photo(&directory, "before.jpg");
        let fingerprints = HashMap::from([(old.relative_path.clone(), "same-photo".into())]);
        index_photos(&mut connection, &[old], &fingerprints, &HashMap::new()).unwrap();
        connection
            .execute(
                "INSERT INTO decisions(relative_path, decision, rating, updated_at) VALUES ('before.jpg', 'keep', 4, unixepoch())",
                [],
            )
            .unwrap();
        let indexed = read_indexed_photos(&connection).unwrap();
        let current_paths = HashSet::from(["after.jpg".to_string()]);
        let current_fingerprints =
            HashMap::from([("after.jpg".to_string(), "same-photo".to_string())]);
        migrate_renamed_decisions(&connection, &indexed, &current_paths, &current_fingerprints)
            .unwrap();
        assert_eq!(
            read_decisions(&connection).unwrap().get("after.jpg"),
            Some(&("keep".into(), 4))
        );
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn thumbnail_cache_prunes_old_entries_without_removing_protected_preview() {
        let directory = test_directory("thumbnail-prune-test");
        let _ = fs::remove_dir_all(&directory);
        let cache = cache_directory(&directory);
        fs::create_dir_all(&cache).unwrap();
        let old = cache.join("old.jpg");
        let keep = cache.join("keep.jpg");
        fs::write(&old, vec![0; 32]).unwrap();
        fs::write(&keep, vec![1; 32]).unwrap();
        prune_thumbnail_cache_to_limit(&cache, 32, Some(&keep));
        assert!(keep.is_file());
        assert!(!old.exists());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn batch_rating_update_commits_all_selected_photos_together() {
        let directory = test_directory("batch-rating-test");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("first.jpg"), b"first").unwrap();
        fs::write(directory.join("second.jpg"), b"second").unwrap();
        save_ratings_batch(
            directory.to_string_lossy().into(),
            vec!["first.jpg".into(), "second.jpg".into()],
            5,
        )
        .unwrap();
        let connection = open_manifest(&directory).unwrap();
        let ratings = read_decisions(&connection).unwrap();
        assert_eq!(ratings.get("first.jpg"), Some(&("unreviewed".into(), 5)));
        assert_eq!(ratings.get("second.jpg"), Some(&("unreviewed".into(), 5)));
        fs::remove_dir_all(&directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_sync_preserves_unmanaged_tags_and_replaces_cadris_decision() {
        let directory = std::env::temp_dir().join(format!("cadris-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("photo.jpg");
        fs::write(&file, b"test").unwrap();
        let existing = vec!["Client: Alice".to_string(), "Cadris: Reject\n6".to_string()];
        let mut bytes = Vec::new();
        plist::to_writer_binary(&mut bytes, &existing).unwrap();
        xattr::set(&file, "com.apple.metadata:_kMDItemUserTags", &bytes).unwrap();

        assert!(sync_native_decision(&file, "keep").unwrap());

        let stored = xattr::get(&file, "com.apple.metadata:_kMDItemUserTags")
            .unwrap()
            .unwrap();
        let tags: Vec<String> = plist::from_bytes(&stored).unwrap();
        assert!(tags.iter().any(|tag| tag == "Client: Alice"));
        assert!(tags.iter().any(|tag| tag == "Cadris: Keep\n2"));
        assert!(!tags.iter().any(|tag| tag.starts_with("Cadris: Reject")));
        fs::remove_dir_all(&directory).unwrap();
    }
}
