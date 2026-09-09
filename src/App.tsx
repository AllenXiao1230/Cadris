import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type UIEvent as ReactUIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { clearThumbnailCache } from "./cache/thumbnailCache";
import { CompareView } from "./components/CompareView";
import { GalleryView } from "./components/GalleryView";
import { Icon } from "./components/Icon";
import { LoupeView } from "./components/LoupeView";
import { SettingsPage } from "./components/SettingsPage";
import { AdvancedFilters, emptyAdvancedFilter, type AdvancedFilter } from "./components/AdvancedFilters";
import { usePhotoKeyboard } from "./hooks/usePhotoKeyboard";
import { selectionForItem } from "./lib/photos";
import "./App.css";

type Decision = "unreviewed" | "keep" | "reject";
type View = "grid" | "loupe" | "compare";
type SortOption = "name-asc" | "name-desc" | "captured-newest" | "captured-oldest" | "rating-desc";
type ShortcutAction = "keep" | "reject" | "unreviewed" | "rating-0" | "rating-1" | "rating-2" | "rating-3" | "rating-4" | "rating-5" | "previous" | "next" | "toggle-view" | "grid" | "compare-toggle" | "zoom-out" | "zoom-in";
type ShortcutMap = Record<ShortcutAction, string>;
type Photo = { path: string; relativePath: string; name: string; extension: string; size: number; modifiedAt: number; camera?: string; lens?: string; capturedAt?: string; exposure?: string; aperture?: string; iso?: string; focalLength?: string; exposureCompensation?: string; dimensions?: string; shooting?: string; orientation?: string; decision: Decision; rating: number; ratio?: number };
type BatchDecisionSaveResult = { nativeSynced: number; pendingNativeSync: number };
type LastAction = { photos: (Pick<Photo, "relativePath" | "name"> & { before: Decision | number })[]; field: "decision" | "rating"; after: Decision | number };
type LibraryItem = { key: string; kind: "photo" | "pair"; primary: Photo; photos: Photo[] };
type GalleryItem = { item: LibraryItem; index: number; ratio: number; width: number };
type GalleryRow = { items: GalleryItem[]; height: number; top: number };
type BurstGroup = { id: string; photos: Photo[] };
type LibraryChange = { root: string; paths: string[] };
type ScanUpdate = { root: string; phase: string; processed: number; total: number; photos: Photo[] };
type Theme = "midnight" | "graphite" | "warm";
type AssistanceResult = { relativePath: string; blurHint: boolean; exposureHint?: string; similarGroup?: string; eyeHint?: string };
type CacheStatus = { bytes: number; files: number; limitMb: number; failures: { relativePath: string; error: string; updatedAt: number }[] };
type NativeSyncStatus = { available: boolean; pending: number; issues: { relativePath: string; decision: string; attempts: number; lastError?: string }[] };
type ReviewSession = { id: string; activePath?: string; reviewedCount: number; totalCount: number; pausedAt?: number };
type BurstBestFrame = { burstId: string; relativePath: string };
type DecisionHistoryEntry = { id: number; previousDecision: Decision; nextDecision: Decision; previousRating: number; nextRating: number; changedAt: number };
type ReviewSnapshot = { id: string; label: string; createdAt: number };

const labels: Record<Decision, string> = { unreviewed: "未審", keep: "保留", reject: "淘汰" };
const defaultShortcuts: ShortcutMap = { keep: "Z", reject: "X", unreviewed: "U", "rating-0": "0", "rating-1": "1", "rating-2": "2", "rating-3": "3", "rating-4": "4", "rating-5": "5", previous: "ArrowLeft", next: "ArrowRight", "toggle-view": "Space", grid: "G", "compare-toggle": "C", "zoom-out": "-", "zoom-in": "=" };
const shortcutGroups: { title: string; actions: { action: ShortcutAction; label: string }[] }[] = [
  { title: "旗標", actions: [{ action: "keep", label: "保留" }, { action: "reject", label: "淘汰" }, { action: "unreviewed", label: "清除旗標" }] },
  { title: "星等", actions: [0, 1, 2, 3, 4, 5].map((rating) => ({ action: ("rating-" + rating) as ShortcutAction, label: rating ? rating + " 星" : "清除評等" })) },
  { title: "檢視與導覽", actions: [{ action: "previous", label: "上一張" }, { action: "next", label: "下一張" }, { action: "toggle-view", label: "開啟單張／縮放細節" }, { action: "grid", label: "圖庫檢視" }, { action: "compare-toggle", label: "加入／移出比較" }, { action: "zoom-out", label: "縮小圖庫" }, { action: "zoom-in", label: "放大圖庫" }] },
];
const GRID_GAP = 14;
const GRID_PADDING = 20;
const LOUPE_MIN_SCALE = 1;
const LOUPE_MAX_SCALE = 4;
const RAW_EXTENSIONS = new Set(["ARW", "CR3", "CR2", "DNG", "NEF", "RAF", "ORF", "RW2"]);
const RENDERED_EXTENSIONS = new Set(["JPG", "JPEG", "HEIC", "HEIF", "PNG", "TIFF", "TIF", "WEBP"]);

function loadTheme(): Theme {
  try {
    const value = window.localStorage.getItem("cadris.theme");
    return value === "graphite" || value === "warm" || value === "midnight" ? value : "midnight";
  } catch { return "midnight"; }
}

const ratingLabel = (value: number) => value ? value + " / 5 星" : "未評等";
const captureTime = (value?: string) => value ? Date.parse(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")) || 0 : 0;
const shortcutLabel = (key: string) => ({ ArrowLeft: "←", ArrowRight: "→", Space: "Space", Escape: "Esc" }[key] ?? key);
const loadShortcuts = (): ShortcutMap => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("cadris.shortcuts") ?? "{}") as Partial<ShortcutMap>;
    const shortcuts = { ...defaultShortcuts, ...saved };
    return Object.keys(defaultShortcuts).every((action) => typeof shortcuts[action as ShortcutAction] === "string") && new Set(Object.values(shortcuts)).size === Object.keys(defaultShortcuts).length ? shortcuts : defaultShortcuts;
  } catch { return defaultShortcuts; }
};
const rowAt = (rows: GalleryRow[], position: number) => {
  let low = 0; let high = rows.length - 1; let answer = 0;
  while (low <= high) { const middle = Math.floor((low + high) / 2); if (rows[middle].top <= position) { answer = middle; low = middle + 1; } else high = middle - 1; }
  return answer;
};

const photoPairKey = (photo: Photo) => {
  const slash = photo.relativePath.lastIndexOf("/");
  const folder = slash >= 0 ? photo.relativePath.slice(0, slash) : "";
  const stem = photo.name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
  return folder + "/" + stem;
};

function buildLibraryItems(photos: Photo[]): LibraryItem[] {
  const candidates = new Map<string, Photo[]>();
  photos.forEach((photo) => {
    const key = photoPairKey(photo);
    candidates.set(key, [...(candidates.get(key) ?? []), photo]);
  });
  const pairs = new Map<string, Photo[]>();
  candidates.forEach((members, key) => {
    if (members.some((photo) => RAW_EXTENSIONS.has(photo.extension)) && members.some((photo) => RENDERED_EXTENSIONS.has(photo.extension))) pairs.set(key, members);
  });
  const seen = new Set<string>();
  const items: LibraryItem[] = [];
  photos.forEach((photo) => {
    if (seen.has(photo.relativePath)) return;
    const key = photoPairKey(photo);
    const pair = pairs.get(key);
    if (!pair) {
      seen.add(photo.relativePath);
      items.push({ key: photo.relativePath, kind: "photo", primary: photo, photos: [photo] });
      return;
    }
    pair.forEach((member) => seen.add(member.relativePath));
    const primary = pair.find((member) => RENDERED_EXTENSIONS.has(member.extension)) ?? pair[0];
    items.push({ key: "pair:" + key, kind: "pair", primary, photos: pair });
  });
  return items;
}

function buildBurstGroups(items: LibraryItem[], gapMs = 1500): BurstGroup[] {
  const byFolder = new Map<string, { photo: Photo; timestamp: number }[]>();
  items.forEach((item) => {
    const timestamp = captureTime(item.primary.capturedAt);
    if (!timestamp) return;
    const slash = item.primary.relativePath.lastIndexOf("/");
    const folder = slash >= 0 ? item.primary.relativePath.slice(0, slash) : "";
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), { photo: item.primary, timestamp }]);
  });
  const groups: BurstGroup[] = [];
  byFolder.forEach((photos, folder) => {
    const ordered = photos.sort((left, right) => left.timestamp - right.timestamp);
    let sequence: { photo: Photo; timestamp: number }[] = [];
    const finish = () => {
      if (sequence.length >= 3) groups.push({ id: "burst:" + folder + ":" + sequence[0].timestamp, photos: sequence.map((entry) => entry.photo) });
      sequence = [];
    };
    ordered.forEach((entry) => {
      const previous = sequence[sequence.length - 1];
      if (previous && entry.timestamp - previous.timestamp > gapMs) finish();
      sequence.push(entry);
    });
    finish();
  });
  return groups;
}

export default function App() {
  const [root, setRoot] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [active, setActive] = useState(0);
  const [view, setView] = useState<View>("grid");
  const [gridMode, setGridMode] = useState<"square" | "photo">("square");
  const [sortBy, setSortBy] = useState<SortOption>("name-asc");
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(loadShortcuts);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [editingShortcut, setEditingShortcut] = useState<ShortcutAction | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState("");
  const [loupeScale, setLoupeScale] = useState(LOUPE_MIN_SCALE);
  const [loupePan, setLoupePan] = useState({ x: 0, y: 0 });
  const [filter, setFilter] = useState<"all" | Decision>("all");
  const [advancedFilter, setAdvancedFilter] = useState<AdvancedFilter>(emptyAdvancedFilter);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [externalChanges, setExternalChanges] = useState(0);
  const [status, setStatus] = useState("開啟一個照片資料夾，開始篩選。");
  const [gridSize, setGridSize] = useState(185);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [burstGapMs, setBurstGapMs] = useState(() => Number(window.localStorage.getItem("cadris.burst-gap-ms")) || 1500);
  const [previewProfile, setPreviewProfile] = useState<"speed" | "balanced" | "quality">(() => (window.localStorage.getItem("cadris.preview-profile") as "speed" | "balanced" | "quality") || "balanced");
  const [preloadCount, setPreloadCount] = useState(() => Number(window.localStorage.getItem("cadris.preload-count")) || 12);
  const [rawCacheOnly, setRawCacheOnly] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [syncStatus, setSyncStatus] = useState<NativeSyncStatus | null>(null);
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);
  const [assistance, setAssistance] = useState<AssistanceResult[]>([]);
  const [burstBestFrames, setBurstBestFrames] = useState<Map<string, string>>(new Map());
  const [decisionHistory, setDecisionHistory] = useState<DecisionHistoryEntry[]>([]);
  const [reviewSnapshots, setReviewSnapshots] = useState<ReviewSnapshot[]>([]);
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [comparison, setComparison] = useState<string[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [compareZoom, setCompareZoom] = useState(false);
  const [comparePan, setComparePan] = useState({ x: 0, y: 0 });
  const [gridScrollTop, setGridScrollTop] = useState(0);
  const [gridBounds, setGridBounds] = useState({ width: 0, height: 0 });
  const gridViewportRef = useRef<HTMLElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const settingsScrollTopRef = useRef<number | null>(null);
  const gridScrollFrameRef = useRef<number | null>(null);
  const pendingGridScrollTopRef = useRef(0);
  const ratioFrameRef = useRef<number | null>(null);
  const pendingRatiosRef = useRef(new Map<string, number>());
  const scanningRootRef = useRef("");
  const followActiveRef = useRef(false);
  const loupeStageRef = useRef<HTMLDivElement>(null);
  const loupePointerRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const comparePointerRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);

  const stats = useMemo(() => {
    const next = { all: photos.length, unreviewed: 0, keep: 0, reject: 0 };
    photos.forEach((photo) => { next[photo.decision] += 1; });
    return next;
  }, [photos]);
  const searchPaths = useMemo(() => new Set(searchResults ?? []), [searchResults]);
  const selectedPaths = useMemo(() => new Set(selection), [selection]);
  const assistanceByPath = useMemo(() => new Map(assistance.map((entry) => [entry.relativePath, entry])), [assistance]);
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const matches = photos.filter((photo) => {
      if (filter !== "all" && photo.decision !== filter) return false;
      if (advancedFilter.camera && photo.camera !== advancedFilter.camera) return false;
      if (advancedFilter.lens && photo.lens !== advancedFilter.lens) return false;
      if (advancedFilter.focal && !(photo.focalLength ?? "").toLocaleLowerCase().includes(advancedFilter.focal.toLocaleLowerCase())) return false;
      if (advancedFilter.iso && !((photo.iso ?? photo.exposure ?? "").toLocaleLowerCase().includes(advancedFilter.iso.toLocaleLowerCase()))) return false;
      if (advancedFilter.aperture && !((photo.aperture ?? photo.exposure ?? "").toLocaleLowerCase().includes(advancedFilter.aperture.toLocaleLowerCase()))) return false;
      const captured = (photo.capturedAt ?? "").replace(/^(\d{4}):(\d{2}):(\d{2}).*/, "$1-$2-$3");
      if (advancedFilter.dateFrom && (!captured || captured < advancedFilter.dateFrom)) return false;
      if (advancedFilter.dateTo && (!captured || captured > advancedFilter.dateTo)) return false;
      if (advancedFilter.minRating && photo.rating < Number(advancedFilter.minRating)) return false;
      if (advancedFilter.minSize && photo.size < Number(advancedFilter.minSize) * 1_000_000) return false;
      if (advancedFilter.maxSize && photo.size > Number(advancedFilter.maxSize) * 1_000_000) return false;
      const assist = assistanceByPath.get(photo.relativePath);
      if (advancedFilter.assistance === "blur" && !assist?.blurHint) return false;
      if (advancedFilter.assistance === "exposure" && !assist?.exposureHint) return false;
      if (advancedFilter.assistance === "similar" && !assist?.similarGroup) return false;
      if (advancedFilter.preview === "failed" && !cacheStatus?.failures.some((failure) => failure.relativePath === photo.relativePath)) return false;
      if (advancedFilter.preview === "ready" && cacheStatus?.failures.some((failure) => failure.relativePath === photo.relativePath)) return false;
      if (!term) return true;
      if (searchResults) return searchPaths.has(photo.relativePath);
      return [photo.name, photo.camera, photo.lens].filter((value): value is string => Boolean(value)).some((value) => value.toLocaleLowerCase().includes(term));
    });
    return matches.sort((left, right) => {
      if (sortBy === "name-desc") return right.name.localeCompare(left.name, undefined, { numeric: true });
      if (sortBy === "captured-newest") return captureTime(right.capturedAt) - captureTime(left.capturedAt) || left.name.localeCompare(right.name);
      if (sortBy === "captured-oldest") return captureTime(left.capturedAt) - captureTime(right.capturedAt) || left.name.localeCompare(right.name);
      if (sortBy === "rating-desc") return right.rating - left.rating || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
  }, [photos, filter, search, searchPaths, searchResults, sortBy, advancedFilter, assistanceByPath, cacheStatus]);
  const preLibraryItems = useMemo(() => buildLibraryItems(visible), [visible]);
  const preBurstGroups = useMemo(() => buildBurstGroups(preLibraryItems, burstGapMs), [preLibraryItems, burstGapMs]);
  const preBurstPaths = useMemo(() => new Set(preBurstGroups.flatMap((group) => group.photos.map((photo) => photo.relativePath))), [preBurstGroups]);
  const libraryItems = useMemo(() => preLibraryItems.filter((item) => (!advancedFilter.burstOnly || item.photos.some((photo) => preBurstPaths.has(photo.relativePath))) && (!advancedFilter.pairedOnly || item.kind === "pair")), [preLibraryItems, advancedFilter.burstOnly, advancedFilter.pairedOnly, preBurstPaths]);
  const burstGroups = useMemo(() => buildBurstGroups(libraryItems, burstGapMs), [libraryItems, burstGapMs]);
  const burstByPhoto = useMemo(() => {
    const next = new Map<string, { position: number; total: number; group: BurstGroup }>();
    burstGroups.forEach((group) => group.photos.forEach((photo, position) => next.set(photo.relativePath, { position, total: group.photos.length, group })));
    return next;
  }, [burstGroups]);
  const currentItem = libraryItems[active] ?? libraryItems[0];
  const current = currentItem?.primary;
  const selectedItemCount = useMemo(() => libraryItems.filter((item) => item.photos.every((photo) => selectedPaths.has(photo.relativePath))).length, [libraryItems, selectedPaths]);
  const comparisonPhotos = useMemo(() => comparison.map((relativePath) => photos.find((photo) => photo.relativePath === relativePath)).filter((photo): photo is Photo => Boolean(photo)), [comparison, photos]);
  const currentBurst = current ? burstByPhoto.get(current.relativePath) : undefined;
  const reviewed = stats.all - stats.unreviewed;
  const columnCount = Math.max(1, Math.floor((Math.max(gridBounds.width - GRID_PADDING * 2, gridSize) + GRID_GAP) / (gridSize + GRID_GAP)));
  const cardWidth = Math.max(gridSize, (Math.max(gridBounds.width - GRID_PADDING * 2, gridSize) - (columnCount - 1) * GRID_GAP) / columnCount);
  const cardHeight = gridMode === "square" ? Math.round(cardWidth) : Math.round(cardWidth * 0.75 + 76);
  const rowCount = Math.ceil(libraryItems.length / columnCount);
  const firstRow = Math.max(0, Math.floor(gridScrollTop / cardHeight) - 2);
  const lastRow = Math.min(rowCount, Math.ceil((gridScrollTop + Math.max(gridBounds.height, cardHeight)) / cardHeight) + 2);
  const virtualStart = firstRow * columnCount;
  const virtualItems = libraryItems.slice(virtualStart, lastRow * columnCount);
  const galleryRows = useMemo(() => {
    if (gridMode !== "photo" || !libraryItems.length) return [] as GalleryRow[];
    const availableWidth = Math.max(320, gridBounds.width - GRID_PADDING * 2);
    const preferredHeight = Math.max(120, Math.min(260, gridSize));
    const rows: GalleryRow[] = [];
    let pending: GalleryItem[] = []; let ratioTotal = 0; let top = GRID_PADDING;
    const finishRow = () => {
      if (!pending.length) return;
      const height = Math.max(92, (availableWidth - GRID_GAP * (pending.length - 1)) / ratioTotal);
      const items = pending.map((item) => ({ ...item, width: item.ratio * height }));
      rows.push({ items, height, top });
      top += height + GRID_GAP; pending = []; ratioTotal = 0;
    };
    libraryItems.forEach((item, index) => {
      const ratio = Math.max(0.45, Math.min(3.2, item.primary.ratio ?? 4 / 3));
      if (pending.length && (ratioTotal + ratio) * preferredHeight + GRID_GAP * pending.length > availableWidth) finishRow();
      pending.push({ item, index, ratio, width: 0 }); ratioTotal += ratio;
    });
    finishRow();
    return rows;
  }, [libraryItems, gridBounds.width, gridMode, gridSize]);
  const firstGalleryRow = Math.max(0, rowAt(galleryRows, Math.max(0, gridScrollTop - GRID_PADDING)) - 2);
  const lastGalleryRow = Math.min(galleryRows.length, rowAt(galleryRows, gridScrollTop + Math.max(gridBounds.height, 300)) + 3);
  const galleryHeight = galleryRows.length ? galleryRows[galleryRows.length - 1].top + galleryRows[galleryRows.length - 1].height + GRID_PADDING : gridBounds.height;
  const activeGalleryRow = useMemo(() => galleryRows.findIndex((row) => row.items.some((item) => item.index === active)), [active, galleryRows]);

  function notify(message: string) {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1500);
  }

  function closeSettings() {
    setEditingShortcut(null);
    setSettings(false);
  }

  function rememberRatio(relativePath: string, image: HTMLImageElement) {
    const ratio = image.naturalWidth / image.naturalHeight;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    pendingRatiosRef.current.set(relativePath, ratio);
    if (ratioFrameRef.current !== null) return;
    ratioFrameRef.current = window.requestAnimationFrame(() => {
      ratioFrameRef.current = null;
      const ratios = pendingRatiosRef.current;
      pendingRatiosRef.current = new Map();
      setPhotos((all) => {
        let changed = false;
        const next = all.map((photo) => {
          const nextRatio = ratios.get(photo.relativePath);
          if (!nextRatio || Math.abs((photo.ratio ?? 0) - nextRatio) <= 0.01) return photo;
          changed = true;
          return { ...photo, ratio: nextRatio };
        });
        return changed ? next : all;
      });
    });
  }

  async function choose() {
    const folder = await open({ directory: true, multiple: false, title: "選擇照片資料夾" });
    if (typeof folder === "string") await scan(folder);
  }

  async function refreshLibraryTools(folder = root) {
    if (!folder) return;
    const [cache, sync, session, bestFrames, snapshots] = await Promise.all([
      invoke<CacheStatus>("cache_status", { root: folder }).catch(() => null),
      invoke<NativeSyncStatus>("native_sync_status", { root: folder }).catch(() => null),
      invoke<ReviewSession | null>("resume_review_session", { root: folder }).catch(() => null),
      invoke<BurstBestFrame[]>("burst_best_frames", { root: folder }).catch(() => []),
      invoke<ReviewSnapshot[]>("review_snapshots", { root: folder }).catch(() => []),
    ]);
    setCacheStatus(cache); setSyncStatus(sync); setReviewSession(session); setBurstBestFrames(new Map(bestFrames.map((frame) => [frame.burstId, frame.relativePath]))); setReviewSnapshots(snapshots);
  }

  async function scan(folder: string) {
    const changedLibrary = root !== folder;
    scanningRootRef.current = folder;
    if (changedLibrary) {
      clearThumbnailCache();
      setPhotos([]); setActive(0); setView("grid"); setLastAction(null); setComparison([]); setSelection([]); setSelectionAnchor(null); setCompareZoom(false); setComparePan({ x: 0, y: 0 }); setSearchResults(null);
    }
    setRoot(folder);
    setStatus("正在建立圖庫索引…");
    try {
      const data = await invoke<Photo[]>("scan_library", { root: folder });
      if (scanningRootRef.current !== folder) return;
      setPhotos((currentPhotos) => {
        const ratios = new Map(currentPhotos.map((photo) => [photo.relativePath, photo.ratio]));
        return data.map((photo) => ratios.get(photo.relativePath) ? { ...photo, ratio: ratios.get(photo.relativePath) } : photo);
      });
      setActive(0); setView("grid"); setLastAction(null); setComparison([]); setSelection([]); setSelectionAnchor(null); setCompareZoom(false); setComparePan({ x: 0, y: 0 }); setSearchResults(null); setExternalChanges(0);
      let watching = true;
      try { await invoke("watch_library", { root: folder }); } catch { watching = false; }
      await refreshLibraryTools(folder);
      try {
        const session = await invoke<ReviewSession>("update_review_session", { root: folder, activePath: data[0]?.relativePath ?? null, reviewedCount: data.filter((photo) => photo.decision !== "unreviewed").length, totalCount: data.length, paused: false });
        setReviewSession(session);
      } catch { /* The photo review flow stays usable even if session metadata is unavailable. */ }
      setStatus(data.length ? "已載入 " + data.length + " 張影像。篩選決定會安全保存到此圖庫。" + (watching ? " 正在監看外部更新。" : " 此圖庫目前無法監看外部更新。") : "這個資料夾沒有支援的影像；請改選含照片的資料夾。");
    } catch {
      setStatus("無法開啟圖庫。請確認資料夾仍可讀取，然後再試一次。");
    }
  }

  async function runAssistance() {
    if (!root || !photos.length) return;
    setStatus("正在以本機技術提示分析可解碼預覽…");
    try {
      const result = await invoke<AssistanceResult[]>("analyze_assistance", { root, relativePaths: photos.map((photo) => photo.relativePath) });
      setAssistance(result);
      setStatus("已完成本機技術提示；結果只供人工參考，不會自動淘汰照片。");
      notify("本機提示已更新");
    } catch { setStatus("無法完成本機技術提示；部分 RAW 可能尚未有可解碼預覽。"); }
  }

  async function markBurstBest() {
    if (!root || !currentBurst || !current) return;
    try { await invoke("save_burst_best_frame", { root, burstId: currentBurst.group.id, relativePath: current.relativePath }); setBurstBestFrames((frames) => new Map(frames).set(currentBurst.group.id, current.relativePath)); notify("已指定為連拍最佳照片"); }
    catch { setStatus("無法設定這張連拍最佳照片。"); }
  }

  async function restoreHistory(entry: Pick<DecisionHistoryEntry, "id" | "previousDecision" | "nextDecision" | "previousRating" | "nextRating">) {
    if (!root || !current) return;
    try {
      await invoke("restore_history_entry", { root, id: entry.id });
      setPhotos((all) => all.map((photo) => photo.relativePath === current.relativePath ? { ...photo, decision: entry.previousDecision, rating: entry.previousRating } : photo));
      setDecisionHistory((entries) => entries.filter((item) => item.id !== entry.id));
      setStatus("已從決策歷程還原此照片。 ");
    } catch { setStatus("無法從決策歷程還原此照片。"); }
  }

  async function saveSnapshot() {
    if (!root) return;
    try { await invoke("create_review_snapshot", { root, label: "手動快照" }); await refreshLibraryTools(); setStatus("已在 .cadris/snapshots 建立可攜決定快照。"); notify("已建立快照"); }
    catch { setStatus("無法建立決定快照。"); }
  }

  async function mergeSnapshot(id: string) {
    if (!root) return;
    try { const restored = await invoke<number>("merge_review_snapshot", { root, id }); await scan(root); setStatus(`已安全合併 ${restored} 項仍存在的照片決定。`); }
    catch { setStatus("無法合併決定快照。"); }
  }

  async function updateSession(paused = false) {
    if (!root || !photos.length) return;
    try {
      const session = await invoke<ReviewSession>("update_review_session", { root, id: reviewSession?.id, activePath: current?.relativePath, reviewedCount: reviewed, totalCount: stats.all, paused });
      setReviewSession(session);
      setStatus(paused ? "工作階段已暫停，可從相同圖庫繼續。" : "工作階段已儲存，目前位置可繼續。 ");
    } catch { setStatus("無法儲存工作階段。"); }
  }

  async function retrySync(repair = false) {
    if (!root) return;
    try { const next = await invoke<NativeSyncStatus>(repair ? "repair_native_sync" : "retry_native_sync", { root }); setSyncStatus(next); setStatus(next.pending ? "仍有 " + next.pending + " 項 Finder 同步等待重試。" : "Finder 同步佇列已完成。"); }
    catch { setStatus("無法更新 Finder 同步佇列。"); }
  }

  async function updateCacheLimit(limitMb: number) {
    if (!root) return;
    try { const next = await invoke<CacheStatus>("set_cache_limit", { root, limitMb }); setCacheStatus(next); }
    catch { setStatus("無法更新快取上限。"); }
  }

  async function clearDerivedCache() {
    if (!root) return;
    try { clearThumbnailCache(); const next = await invoke<CacheStatus>("clear_thumbnail_cache", { root }); setCacheStatus(next); setStatus("已清除衍生預覽快取；原始照片未變更。"); }
    catch { setStatus("無法清除衍生快取。"); }
  }

  async function exportLibrary(format: "csv" | "json" | "xmp") {
    if (!root) return;
    const destination = format === "xmp"
      ? await open({ directory: true, multiple: false, title: "選擇新的 XMP 輸出資料夾" })
      : await open({ directory: false, multiple: false, title: "選擇匯出檔案位置" });
    if (typeof destination !== "string") return;
    try { await invoke("export_decisions", { root, request: { format, destination } }); setStatus(format === "xmp" ? "已輸出 Lightroom 可讀的 XMP sidecar；原始照片未變更。" : "已輸出非破壞式決定清單。"); }
    catch { setStatus("無法匯出決定清單。XMP 需要選擇一個尚不存在的新資料夾。 "); }
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ScanUpdate>("cadris://scan-progress", (event) => {
      const update = event.payload;
      if (disposed || update.root !== scanningRootRef.current) return;
      if (update.photos.length) {
        setPhotos((currentPhotos) => {
          const byPath = new Map(currentPhotos.map((photo) => [photo.relativePath, photo]));
          update.photos.forEach((photo) => {
            const previous = byPath.get(photo.relativePath);
            byPath.set(photo.relativePath, previous?.ratio ? { ...photo, ratio: previous.ratio } : photo);
          });
          return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
        });
      }
      if (update.phase !== "完成") {
        const progress = update.total ? " " + Math.min(update.processed, update.total) + " / " + update.total : "";
        setStatus(update.phase + progress + "…");
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    const query = search.trim();
    if (!root || !query) { setSearchResults(null); return; }
    let cancelled = false;
    setSearchResults(null);
    const timer = window.setTimeout(() => {
      void invoke<string[]>("search_library", { root, query })
        .then((paths) => { if (!cancelled) setSearchResults(paths); })
        .catch(() => { if (!cancelled) setSearchResults(null); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [root, search]);

  useEffect(() => {
    if (!root) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LibraryChange>("cadris://library-changed", (event) => {
      if (!disposed && event.payload.root === root) setExternalChanges((count) => Math.min(999, count + Math.max(1, event.payload.paths.length)));
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [root]);

  useEffect(() => {
    if (!root || !current) { setDecisionHistory([]); return; }
    let cancelled = false;
    void invoke<DecisionHistoryEntry[]>("decision_history", { root, relativePath: current.relativePath })
      .then((entries) => { if (!cancelled) setDecisionHistory(entries); })
      .catch(() => { if (!cancelled) setDecisionHistory([]); });
    return () => { cancelled = true; };
  }, [root, current?.relativePath, photos]);

  async function decision(value: Decision, fromShortcut = false) {
    const selected = photos.filter((photo) => selectedPaths.has(photo.relativePath));
    const targets = selected.length ? selected : currentItem?.kind === "pair" ? currentItem.photos : current ? [current] : [];
    if (!root || !targets.length || saving || targets.every((photo) => photo.decision === value)) return;
    setSaving(true);
    try {
      const result = await invoke<BatchDecisionSaveResult>("save_decisions_batch", { root, relativePaths: targets.map((photo) => photo.relativePath), decision: value });
      const targetPaths = new Set(targets.map((photo) => photo.relativePath));
      setPhotos((all) => all.map((item) => targetPaths.has(item.relativePath) ? { ...item, decision: value } : item));
      setLastAction({ photos: targets.map((photo) => ({ relativePath: photo.relativePath, name: photo.name, before: photo.decision })), field: "decision", after: value });
      const subject = targets.length > 1 ? targets.length + " 張照片" : targets[0].name;
      setStatus(result.pendingNativeSync ? subject + " 已設為" + labels[value] + "，Finder 標籤會自動重試同步。" : result.nativeSynced ? subject + " 已設為" + labels[value] + "，Finder 標籤已同步。" : subject + " 已設為" + labels[value] + "。");
      if (fromShortcut) notify(shortcutLabel(shortcuts[value]) + "　" + labels[value]);
      if (fromShortcut && autoAdvance && (filter === "all" || filter === value)) move(1);
    } catch {
      setStatus("旗標尚未保存。請確認圖庫與照片可寫入，然後再試一次。");
    } finally {
      setSaving(false);
    }
  }

  async function rating(value: number, fromShortcut = false) {
    const selected = photos.filter((photo) => selectedPaths.has(photo.relativePath));
    const targets = selected.length ? selected : currentItem?.kind === "pair" ? currentItem.photos : current ? [current] : [];
    if (!root || !targets.length || saving || targets.every((photo) => photo.rating === value)) return;
    setSaving(true);
    try {
      await invoke("save_ratings_batch", { root, relativePaths: targets.map((photo) => photo.relativePath), rating: value });
      const targetPaths = new Set(targets.map((photo) => photo.relativePath));
      setPhotos((all) => all.map((item) => targetPaths.has(item.relativePath) ? { ...item, rating: value } : item));
      setLastAction({ photos: targets.map((photo) => ({ relativePath: photo.relativePath, name: photo.name, before: photo.rating })), field: "rating", after: value });
      const subject = targets.length > 1 ? targets.length + " 張照片" : targets[0].name;
      setStatus(subject + " 已設為 " + ratingLabel(value) + "。");
      if (fromShortcut) notify(value + "　" + ratingLabel(value));
    } catch {
      setStatus("星等尚未保存。請確認圖庫與照片可寫入，然後再試一次。");
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (!root || !lastAction || saving) return;
    setSaving(true);
    try {
      if (lastAction.field === "decision") {
        const groups = new Map<Decision, string[]>();
        lastAction.photos.forEach((photo) => {
          const decision = photo.before as Decision;
          groups.set(decision, [...(groups.get(decision) ?? []), photo.relativePath]);
        });
        const results = await Promise.all([...groups].map(([decision, relativePaths]) => invoke<BatchDecisionSaveResult>("save_decisions_batch", { root, relativePaths, decision })));
        const before = new Map(lastAction.photos.map((photo) => [photo.relativePath, photo.before as Decision]));
        setPhotos((all) => all.map((item) => before.has(item.relativePath) ? { ...item, decision: before.get(item.relativePath)! } : item));
        const subject = lastAction.photos.length > 1 ? lastAction.photos[0].name + " 與 " + (lastAction.photos.length - 1) + " 個配對檔" : lastAction.photos[0].name;
        setStatus(results.some((result) => result.pendingNativeSync) ? "已復原 " + subject + " 的旗標；Finder 標籤會自動重試同步。" : "已復原 " + subject + " 的旗標。");
      } else {
        const groups = new Map<number, string[]>();
        lastAction.photos.forEach((photo) => {
          const rating = photo.before as number;
          groups.set(rating, [...(groups.get(rating) ?? []), photo.relativePath]);
        });
        await Promise.all([...groups].map(([rating, relativePaths]) => invoke("save_ratings_batch", { root, relativePaths, rating })));
        const before = new Map(lastAction.photos.map((photo) => [photo.relativePath, photo.before as number]));
        setPhotos((all) => all.map((item) => before.has(item.relativePath) ? { ...item, rating: before.get(item.relativePath)! } : item));
        const subject = lastAction.photos.length > 1 ? lastAction.photos[0].name + " 與 " + (lastAction.photos.length - 1) + " 個配對檔" : lastAction.photos[0].name;
        setStatus("已復原 " + subject + " 的星等。");
      }
      setLastAction(null);
      notify("已復原上一個動作");
    } catch {
      setStatus("無法復原上一個動作。請確認圖庫與照片可寫入後再試一次。");
    } finally {
      setSaving(false);
    }
  }

  function toggleComparison(photo = current) {
    if (!photo) return;
    if (comparison.includes(photo.relativePath)) {
      setComparison((items) => items.filter((relativePath) => relativePath !== photo.relativePath));
      if (view === "compare" && comparison.length <= 2) setView("loupe");
      notify("已從比較清單移除");
      return;
    }
    if (comparison.length >= 8) { notify("比較最多可放入 8 張照片"); return; }
    setComparison((items) => [...items, photo.relativePath]);
    notify("已加入比較 · " + (comparison.length + 1) + " / 8");
  }

  function addBurstToComparison() {
    if (!current) return;
    const burst = burstByPhoto.get(current.relativePath)?.group;
    if (!burst) { notify("這張照片不在自動偵測的連拍組中"); return; }
    const ordered = [current, ...burst.photos.filter((photo) => photo.relativePath !== current.relativePath)];
    const available = ordered.filter((photo) => !comparison.includes(photo.relativePath)).slice(0, Math.max(0, 8 - comparison.length));
    if (!available.length) { notify("這組連拍已在比較清單中"); return; }
    setComparison((items) => [...items, ...available.map((photo) => photo.relativePath)]);
    notify("已加入 " + available.length + " 張連拍照片比較");
  }

  function addSelectionToComparison() {
    const paths = selection.filter((path) => !comparison.includes(path)).slice(0, Math.max(0, 8 - comparison.length));
    if (!paths.length) { notify("已選照片都在比較清單，或已達 8 張上限"); return; }
    setComparison((items) => [...items, ...paths]);
    notify("已加入 " + paths.length + " 張選取照片比較");
  }

  function openComparison() {
    if (comparisonPhotos.length < 2) { notify("先用 C 將至少 2 張照片加入比較"); return; }
    setCompareZoom(false); setComparePan({ x: 0, y: 0 }); setView("compare");
  }

  function startComparePan(event: ReactPointerEvent<HTMLElement>) {
    if (!compareZoom) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    comparePointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: comparePan.x, originY: comparePan.y };
  }

  function moveComparePan(event: ReactPointerEvent<HTMLElement>) {
    const pointer = comparePointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    setComparePan({ x: pointer.originX + event.clientX - pointer.x, y: pointer.originY + event.clientY - pointer.y });
  }

  function endComparePan(event: ReactPointerEvent<HTMLElement>) {
    if (comparePointerRef.current?.pointerId === event.pointerId) comparePointerRef.current = null;
  }

  function clampLoupePan(pan: { x: number; y: number }, scale = loupeScale) {
    const stage = loupeStageRef.current;
    if (!stage || scale <= LOUPE_MIN_SCALE) return { x: 0, y: 0 };
    const limitX = stage.clientWidth * (scale - 1) / 2;
    const limitY = stage.clientHeight * (scale - 1) / 2;
    return { x: Math.max(-limitX, Math.min(limitX, pan.x)), y: Math.max(-limitY, Math.min(limitY, pan.y)) };
  }

  function updateLoupeScale(value: number) {
    const nextScale = Math.max(LOUPE_MIN_SCALE, Math.min(LOUPE_MAX_SCALE, Math.round(value * 10) / 10));
    setLoupeScale(nextScale);
    setLoupePan((pan) => clampLoupePan(pan, nextScale));
  }

  function resetLoupe() {
    setLoupeScale(LOUPE_MIN_SCALE);
    setLoupePan({ x: 0, y: 0 });
  }

  function startLoupePan(event: ReactPointerEvent<HTMLDivElement>) {
    if (loupeScale <= LOUPE_MIN_SCALE) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    loupePointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: loupePan.x, originY: loupePan.y };
  }

  function moveLoupePan(event: ReactPointerEvent<HTMLDivElement>) {
    const pointer = loupePointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    setLoupePan(clampLoupePan({ x: pointer.originX + event.clientX - pointer.x, y: pointer.originY + event.clientY - pointer.y }));
  }

  function endLoupePan(event: ReactPointerEvent<HTMLDivElement>) {
    if (loupePointerRef.current?.pointerId === event.pointerId) loupePointerRef.current = null;
  }

  function selectPhoto(index: number, event?: ReactMouseEvent<HTMLButtonElement>) {
    const next = selectionForItem(libraryItems, index, selection, selectionAnchor, event ?? {});
    setSelection(next.selection);
    setSelectionAnchor(next.anchor);
    followActiveRef.current = false;
    setActive(index);
    resetLoupe();
  }

  function focusPhoto(index: number) {
    followActiveRef.current = false;
    setActive(index);
  }

  function handleGridScroll(event: ReactUIEvent<HTMLElement>) {
    pendingGridScrollTopRef.current = event.currentTarget.scrollTop;
    if (gridScrollFrameRef.current !== null) return;
    gridScrollFrameRef.current = window.requestAnimationFrame(() => {
      gridScrollFrameRef.current = null;
      const next = pendingGridScrollTopRef.current;
      setGridScrollTop((currentTop) => {
        if (gridMode === "photo") return rowAt(galleryRows, Math.max(0, currentTop - GRID_PADDING)) === rowAt(galleryRows, Math.max(0, next - GRID_PADDING)) ? currentTop : next;
        return Math.floor(currentTop / cardHeight) === Math.floor(next / cardHeight) ? currentTop : next;
      });
    });
  }

  function openSettings() {
    settingsScrollTopRef.current = gridViewportRef.current?.scrollTop ?? gridScrollTop;
    setSettings(true);
  }

  function startShortcutEdit(action: ShortcutAction) {
    setEditingShortcut(action);
    setShortcutStatus("正在設定「" + shortcutGroups.flatMap((group) => group.actions).find((item) => item.action === action)?.label + "」：請按下一個單一按鍵。按 Esc 取消。");
  }

  function restoreShortcuts() {
    setShortcuts(defaultShortcuts);
    setEditingShortcut(null);
    setShortcutStatus("已還原 Lightroom CC 預設快捷鍵。");
  }

  function applySmartCollection(value: string) {
    if (value === "unreviewed" || value === "keep" || value === "reject") {
      setFilter(value); setAdvancedFilter(emptyAdvancedFilter); return;
    }
    setFilter("all");
    setAdvancedFilter({ ...emptyAdvancedFilter,
      burstOnly: value === "burst",
      pairedOnly: value === "pair",
      minRating: value === "rated" ? "1" : "",
      assistance: value === "assistance" ? "blur" : "all",
    });
  }

  const move = (by: number) => {
    const nextIndex = Math.max(0, Math.min(libraryItems.length - 1, active + by));
    const nextItem = libraryItems[nextIndex];
    followActiveRef.current = true;
    setActive(nextIndex);
    if (nextItem) { setSelection(nextItem.photos.map((photo) => photo.relativePath)); setSelectionAnchor(nextIndex); }
    resetLoupe();
  };
  useEffect(() => () => { if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current); }, []);
  useEffect(() => () => { if (gridScrollFrameRef.current !== null) window.cancelAnimationFrame(gridScrollFrameRef.current); }, []);
  useEffect(() => () => { if (ratioFrameRef.current !== null) window.cancelAnimationFrame(ratioFrameRef.current); }, []);
  useEffect(() => { window.localStorage.setItem("cadris.shortcuts", JSON.stringify(shortcuts)); }, [shortcuts]);
  useEffect(() => { window.localStorage.setItem("cadris.theme", theme); }, [theme]);
  useEffect(() => { window.localStorage.setItem("cadris.burst-gap-ms", String(burstGapMs)); }, [burstGapMs]);
  useEffect(() => { window.localStorage.setItem("cadris.preview-profile", previewProfile); clearThumbnailCache(); }, [previewProfile]);
  useEffect(() => { window.localStorage.setItem("cadris.preload-count", String(preloadCount)); }, [preloadCount]);
  useEffect(() => { window.localStorage.setItem("cadris.raw-cache-only", String(rawCacheOnly)); clearThumbnailCache(); }, [rawCacheOnly]);
  useEffect(() => {
    if (!root || !photos.length || !reviewSession) return;
    const timer = window.setTimeout(() => void updateSession(false), 1200);
    return () => window.clearTimeout(timer);
  }, [root, photos.length, current?.relativePath, reviewed]);
  useEffect(() => {
    if (!root || !preloadCount || !libraryItems.length) return;
    const targets = libraryItems.slice(active + 1, active + 1 + preloadCount).map((item) => item.primary.relativePath);
    const timer = window.setTimeout(() => { targets.forEach((relativePath) => { void invoke("thumbnail_for", { root, relativePath, variant: "grid", profile: previewProfile, cacheOnly: false }); }); }, 180);
    return () => window.clearTimeout(timer);
  }, [root, libraryItems, active, preloadCount, previewProfile]);
  useEffect(() => { setActive(0); setSelection([]); setSelectionAnchor(null); }, [filter, search, sortBy]);
  useEffect(() => { setActive((index) => Math.max(0, Math.min(index, Math.max(libraryItems.length - 1, 0)))); }, [libraryItems.length]);
  useEffect(() => { resetLoupe(); }, [current?.relativePath]);
  useEffect(() => { setComparison((items) => items.filter((relativePath) => photos.some((photo) => photo.relativePath === relativePath))); }, [photos]);
  useEffect(() => {
    const viewport = gridViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = 0; setGridScrollTop(0);
  }, [filter, search, gridSize, gridMode]);
  useEffect(() => {
    const viewport = gridViewportRef.current;
    if (!viewport || view !== "grid") return;
    const updateBounds = () => setGridBounds({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [settings, view, photos.length]);
  useEffect(() => {
    if (settings || view !== "grid" || settingsScrollTopRef.current === null) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = gridViewportRef.current;
      const savedScrollTop = settingsScrollTopRef.current;
      if (!viewport || savedScrollTop === null) return;
      const scrollTop = Math.max(0, Math.min(savedScrollTop, viewport.scrollHeight - viewport.clientHeight));
      viewport.scrollTop = scrollTop;
      setGridScrollTop(scrollTop);
      settingsScrollTopRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settings, view, gridBounds.height, galleryHeight, rowCount, cardHeight]);
  useEffect(() => {
    const viewport = gridViewportRef.current;
    if (!followActiveRef.current || !viewport || view !== "grid" || !libraryItems.length) return;
    if (gridMode === "photo") {
      const row = galleryRows[activeGalleryRow];
      if (!row) { followActiveRef.current = false; return; }
      const bottom = row.top + row.height;
      if (row.top < viewport.scrollTop) viewport.scrollTop = Math.max(0, row.top - GRID_PADDING);
      if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight + GRID_PADDING;
      followActiveRef.current = false;
      return;
    }
    const row = Math.floor(active / columnCount);
    const top = row * cardHeight;
    const bottom = top + cardHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = Math.max(0, top - cardHeight);
    if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight + cardHeight;
    followActiveRef.current = false;
  }, [active, activeGalleryRow, cardHeight, columnCount, galleryRows, gridMode, libraryItems.length, view]);
  usePhotoKeyboard({
    editingShortcut, setEditingShortcut, shortcuts, setShortcuts, setShortcutStatus, settings, selection, setSelection, setSelectionAnchor,
    view, setView, hasCurrent: Boolean(current), loupeScale, resetLoupe, updateLoupeScale, setCompareZoom, setComparePan,
    move, toggleComparison: () => toggleComparison(), decision, rating, undo, gridSize, setGridSize, notify,
  });

  return <main className="app" data-theme={theme}>
    <header><div className="brand" aria-label="Cadris"><b aria-hidden="true">C</b></div><button type="button" className="primary icon-button" onClick={choose} aria-label={root ? "更換照片資料夾" : "從資料夾開啟圖庫"} title={root ? "更換照片資料夾" : "從資料夾開啟圖庫"}><Icon name="folder" /></button><span title={root}>{root ? root.split(/[\\/]/).pop() : "未開啟圖庫"}</span>{root && externalChanges > 0 && <button className="library-refresh icon-button" type="button" onClick={() => void scan(root)} aria-label={externalChanges + " 項外部更新，重新整理"} title="重新整理"><Icon name="refresh" /><span>{externalChanges}</span></button>}<button type="button" className="settings-button icon-button" onClick={openSettings} aria-label="設定" title="設定"><Icon name="settings" /></button></header>
    <nav aria-label="圖庫工具列">
      <div className="filter-group" aria-label="篩選照片">{(["all", "unreviewed", "keep", "reject"] as const).map((nextFilter) => <button key={nextFilter} type="button" aria-pressed={filter === nextFilter} className={filter === nextFilter ? "active" : ""} onClick={() => setFilter(nextFilter)}>{nextFilter === "all" ? "全部 " + stats.all : labels[nextFilter] + " " + stats[nextFilter]}</button>)}</div>
      <button type="button" className={showAdvancedFilters ? "active icon-button" : "icon-button"} aria-pressed={showAdvancedFilters} onClick={() => setShowAdvancedFilters((shown) => !shown)} aria-label="進階篩選" title="進階篩選"><Icon name="filter" /></button><label className="sr-only" htmlFor="photo-search">搜尋</label><input id="photo-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋" />
      <label className="sort-control"><span className="sr-only">排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortOption)}><option value="name-asc">檔名 A → Z</option><option value="name-desc">檔名 Z → A</option><option value="captured-newest">時間 ↓</option><option value="captured-oldest">時間 ↑</option><option value="rating-desc">星等 ↓</option></select></label>
    </nav>
    {showAdvancedFilters && <AdvancedFilters value={advancedFilter} photos={photos} onChange={setAdvancedFilter} onReset={() => setAdvancedFilter(emptyAdvancedFilter)} onSmartCollection={applySmartCollection} />}
    {settings ? <SettingsPage root={root} theme={theme} setTheme={setTheme} gridSize={gridSize} setGridSize={setGridSize} autoAdvance={autoAdvance} setAutoAdvance={setAutoAdvance} shortcuts={shortcuts} editingShortcut={editingShortcut} shortcutStatus={shortcutStatus} onClose={closeSettings} onStartShortcutEdit={startShortcutEdit} onRestoreShortcuts={restoreShortcuts} burstGapMs={burstGapMs} setBurstGapMs={setBurstGapMs} previewProfile={previewProfile} setPreviewProfile={setPreviewProfile} preloadCount={preloadCount} setPreloadCount={setPreloadCount} rawCacheOnly={rawCacheOnly} setRawCacheOnly={setRawCacheOnly} cacheStatus={cacheStatus} syncStatus={syncStatus} reviewSession={reviewSession} reviewSnapshots={reviewSnapshots} onUpdateCacheLimit={(limit) => void updateCacheLimit(limit)} onClearDerivedCache={() => void clearDerivedCache()} onRetrySync={(repair) => void retrySync(repair)} onUpdateSession={(paused) => void updateSession(paused)} onSnapshot={() => void saveSnapshot()} onMergeSnapshot={(id) => void mergeSnapshot(id)} onRunAssistance={() => void runAssistance()} onExport={(format) => void exportLibrary(format)} /> : !photos.length ? <section className="empty empty-guide" aria-labelledby="empty-guide-title"><div className="empty-guide-mark" aria-hidden="true"><Icon name="folder" /></div><h1 id="empty-guide-title">{root ? "這個資料夾沒有可檢視的照片" : "從一個照片資料夾開始"}</h1><p className="empty-lede">{root ? "請選擇另一個含有 JPEG、HEIC、TIFF、WebP 或 RAW 照片的資料夾。" : "快速完成第一輪篩選；Cadris 不會移動或刪除你的原始照片。"}</p><button type="button" className="primary open-library-button" onClick={choose} aria-label={root ? "選擇另一個照片資料夾" : "開啟照片資料夾"}><Icon name="folder" /><span>{root ? "選擇另一個資料夾" : "開啟照片資料夾"}</span></button>{root ? <p className="empty-help">照片載入後即可使用 Z、X、U 和 0–5 快速篩選。</p> : <><p className="empty-help">開始後可用鍵盤快速決定：</p><p className="empty-shortcuts" aria-label="快速鍵說明"><span><kbd>Z</kbd> 保留</span><span><kbd>X</kbd> 淘汰</span><span><kbd>U</kbd> 清除</span><span><kbd>0–5</kbd> 星等</span></p></>}</section> : <>
      {view === "grid" ? <GalleryView root={root} gridMode={gridMode} libraryItems={libraryItems} gridViewportRef={gridViewportRef} gridBounds={gridBounds} rowCount={rowCount} cardHeight={cardHeight} firstRow={firstRow} columnCount={columnCount} virtualStart={virtualStart} virtualItems={virtualItems} galleryHeight={galleryHeight} galleryRows={galleryRows} firstGalleryRow={firstGalleryRow} lastGalleryRow={lastGalleryRow} burstByPhoto={burstByPhoto} burstBestFrames={burstBestFrames} selectedPaths={selectedPaths} comparison={comparison} active={active} onFocusPhoto={focusPhoto} onSelectPhoto={selectPhoto} onOpenLoupe={() => setView("loupe")} onScroll={handleGridScroll} onRememberRatio={rememberRatio} /> : view === "loupe" && current ? <LoupeView root={root} current={current} currentItem={currentItem} currentBurst={currentBurst} isBurstBest={Boolean(currentBurst && burstBestFrames.get(currentBurst.group.id) === current.relativePath)} history={decisionHistory} scale={loupeScale} pan={loupePan} stageRef={loupeStageRef} onStartPan={startLoupePan} onMovePan={moveLoupePan} onEndPan={endLoupePan} onScale={updateLoupeScale} onReset={resetLoupe} onRememberRatio={rememberRatio} onAddBurstToComparison={addBurstToComparison} onMarkBurstBest={() => void markBurstBest()} onRestoreHistory={restoreHistory} /> : view === "compare" && comparisonPhotos.length >= 2 ? <CompareView root={root} photos={comparisonPhotos} zoom={compareZoom} pan={comparePan} onToggleZoom={() => { setCompareZoom((value) => !value); setComparePan({ x: 0, y: 0 }); }} onResetPan={() => setComparePan({ x: 0, y: 0 })} onSetRegion={(region) => { const amount = 180; setCompareZoom(true); setComparePan(region === "center" ? { x: 0, y: 0 } : { x: region.includes("right") ? -amount : amount, y: region.includes("bottom") ? -amount : amount }); }} onReturnToGrid={() => setView("grid")} onRemove={toggleComparison} onStartPan={startComparePan} onMovePan={moveComparePan} onEndPan={endComparePan} /> : <section className="empty"><h1>{view === "compare" ? "至少加入兩張照片才能比較" : "沒有符合篩選的照片"}</h1><p>{view === "compare" ? "回到圖庫，以 C 將照片放入比較清單。" : "調整篩選條件或搜尋文字，繼續檢視圖庫。"}</p></section>}
      <section className="bottom-dock" aria-label="檢視與編輯控制">
        <div className="dock-view" aria-label="檢視方式"><button type="button" aria-pressed={view === "grid"} className={(view === "grid" ? "active " : "") + "icon-button"} onClick={() => setView("grid")} aria-label="圖庫" title="圖庫"><Icon name="grid" /></button><button type="button" aria-pressed={view === "loupe"} className={(view === "loupe" ? "active " : "") + "icon-button"} onClick={() => current && setView("loupe")} aria-label="單張" title="單張"><Icon name="single" /></button><button type="button" aria-pressed={view === "compare"} className={(view === "compare" ? "active " : "") + "icon-button has-count"} onClick={openComparison} aria-label={"比較 " + comparison.length + " 張"} title="比較"><Icon name="compare" /><span>{comparison.length}</span></button>{view === "grid" && <><button type="button" aria-pressed={gridMode === "square"} className={(gridMode === "square" ? "active " : "") + "icon-button"} onClick={() => setGridMode("square")} aria-label="正方形圖庫" title="正方形圖庫"><Icon name="square" /></button><button type="button" aria-pressed={gridMode === "photo"} className={(gridMode === "photo" ? "active " : "") + "icon-button"} onClick={() => setGridMode("photo")} aria-label="依相片比例" title="依相片比例"><Icon name="flow" /></button></>}</div>
        <div className="dock-actions"><div className="review-controls" aria-label="目前選取照片的評等與旗標"><div className="rating-controls" aria-label="星等">{[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" className={(current?.rating ?? 0) >= value ? "rating-button rating-active" : "rating-button"} aria-pressed={current?.rating === value} disabled={saving} onClick={() => void rating(current?.rating === value ? 0 : value)} aria-label={value + " 星，再次按下清除星等"} title={value + " 星（再次按下清除星等）"}><Icon name="star" /></button>)}</div><div className="decision-controls" aria-label="旗標"><button type="button" className={current?.decision === "unreviewed" ? "unreviewed selected" : "unreviewed"} aria-pressed={current?.decision === "unreviewed"} disabled={saving} onClick={() => void decision("unreviewed")} aria-label="清除旗標" title="清除旗標 (U)"><Icon name="circle" /></button><button type="button" className={current?.decision === "keep" ? "keep selected" : "keep"} aria-pressed={current?.decision === "keep"} disabled={saving} onClick={() => void decision("keep")} aria-label="保留" title="保留 (Z)"><Icon name="check" /></button><button type="button" className={current?.decision === "reject" ? "reject selected" : "reject"} aria-pressed={current?.decision === "reject"} disabled={saving} onClick={() => void decision("reject")} aria-label="淘汰" title="淘汰 (X)"><Icon name="close" /></button></div></div><div className="compare-controls" aria-label="比較清單"><button type="button" className={current && comparison.includes(current.relativePath) ? "selected" : ""} aria-pressed={Boolean(current && comparison.includes(current.relativePath))} onClick={() => toggleComparison()} aria-label="加入或移出比較" title="加入或移出比較 (C)">C</button>{selection.length > 1 && <button type="button" onClick={addSelectionToComparison} aria-label="將選取照片加入比較" title="加入已選照片">＋選</button>}<button type="button" disabled={comparison.length < 2} onClick={openComparison} aria-label={"比較 " + comparison.length + " 張"} title="比較"><Icon name="compare" /><span>{comparison.length}</span></button></div></div>
        {view === "grid" && <label className="dock-zoom">縮放 <input aria-label="圖庫縮圖尺寸" type="range" min="120" max="340" step="10" value={gridSize} onChange={(event) => setGridSize(Number(event.target.value))} /></label>}
      </section>
    </>}
    {toast && <div className="shortcut-toast" role="status" aria-live="polite">{toast}</div>}
    <footer aria-live="polite"><span>{status}</span>{photos.length > 0 && <span className="progress">{selectedItemCount > 0 && <>{selectedItemCount} 已選　</>}{reviewed === stats.all ? <>第一輪完成 · <button onClick={() => setFilter("reject")}>檢查淘汰</button><button onClick={() => setFilter("keep")}>檢視保留</button></> : <>{reviewed} 已審 · {stats.unreviewed} 待審　{current ? active + 1 + " / " + libraryItems.length : ""}</>}</span>}</footer>
  </main>;
}
