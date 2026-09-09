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
import { usePhotoKeyboard } from "./hooks/usePhotoKeyboard";
import { selectionForItem } from "./lib/photos";
import "./App.css";

type Decision = "unreviewed" | "keep" | "reject";
type View = "grid" | "loupe" | "compare";
type SortOption = "name-asc" | "name-desc" | "captured-newest" | "captured-oldest" | "rating-desc";
type ShortcutAction = "keep" | "reject" | "unreviewed" | "rating-0" | "rating-1" | "rating-2" | "rating-3" | "rating-4" | "rating-5" | "previous" | "next" | "toggle-view" | "grid" | "compare-toggle" | "zoom-out" | "zoom-in";
type ShortcutMap = Record<ShortcutAction, string>;
type Photo = { path: string; relativePath: string; name: string; extension: string; size: number; modifiedAt: number; camera?: string; lens?: string; capturedAt?: string; exposure?: string; focalLength?: string; exposureCompensation?: string; dimensions?: string; shooting?: string; orientation?: string; decision: Decision; rating: number; ratio?: number };
type BatchDecisionSaveResult = { nativeSynced: number; pendingNativeSync: number };
type LastAction = { photos: (Pick<Photo, "relativePath" | "name"> & { before: Decision | number })[]; field: "decision" | "rating"; after: Decision | number };
type LibraryItem = { key: string; kind: "photo" | "pair"; primary: Photo; photos: Photo[] };
type GalleryItem = { item: LibraryItem; index: number; ratio: number; width: number };
type GalleryRow = { items: GalleryItem[]; height: number; top: number };
type BurstGroup = { id: string; photos: Photo[] };
type LibraryChange = { root: string; paths: string[] };
type ScanUpdate = { root: string; phase: string; processed: number; total: number; photos: Photo[] };
type Theme = "midnight" | "graphite" | "warm";

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

function buildBurstGroups(items: LibraryItem[]): BurstGroup[] {
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
      if (previous && entry.timestamp - previous.timestamp > 1500) finish();
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
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [externalChanges, setExternalChanges] = useState(0);
  const [status, setStatus] = useState("開啟一個照片資料夾，開始篩選。");
  const [gridSize, setGridSize] = useState(185);
  const [autoAdvance, setAutoAdvance] = useState(false);
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
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const matches = photos.filter((photo) => {
      if (filter !== "all" && photo.decision !== filter) return false;
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
  }, [photos, filter, search, searchPaths, searchResults, sortBy]);
  const libraryItems = useMemo(() => buildLibraryItems(visible), [visible]);
  const burstGroups = useMemo(() => buildBurstGroups(libraryItems), [libraryItems]);
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
      setStatus(data.length ? "已載入 " + data.length + " 張影像。篩選決定會安全保存到此圖庫。" + (watching ? " 正在監看外部更新。" : " 此圖庫目前無法監看外部更新。") : "這個資料夾沒有支援的影像；請改選含照片的資料夾。");
    } catch {
      setStatus("無法開啟圖庫。請確認資料夾仍可讀取，然後再試一次。");
    }
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
    if (comparison.length >= 4) { notify("比較最多可放入 4 張照片"); return; }
    setComparison((items) => [...items, photo.relativePath]);
    notify("已加入比較 · " + (comparison.length + 1) + " / 4");
  }

  function addBurstToComparison() {
    if (!current) return;
    const burst = burstByPhoto.get(current.relativePath)?.group;
    if (!burst) { notify("這張照片不在自動偵測的連拍組中"); return; }
    const ordered = [current, ...burst.photos.filter((photo) => photo.relativePath !== current.relativePath)];
    const available = ordered.filter((photo) => !comparison.includes(photo.relativePath)).slice(0, Math.max(0, 4 - comparison.length));
    if (!available.length) { notify("這組連拍已在比較清單中"); return; }
    setComparison((items) => [...items, ...available.map((photo) => photo.relativePath)]);
    notify("已加入 " + available.length + " 張連拍照片比較");
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
    <header><div className="brand" aria-label="Cadris"><b aria-hidden="true">C</b></div><button type="button" className="primary icon-button" onClick={choose} aria-label="開啟照片資料夾" title="開啟照片資料夾"><Icon name="folder" /></button><span title={root}>{root ? root.split(/[\\/]/).pop() : "未開啟圖庫"}</span>{root && externalChanges > 0 && <button className="library-refresh icon-button" type="button" onClick={() => void scan(root)} aria-label={externalChanges + " 項外部更新，重新整理"} title="重新整理"><Icon name="refresh" /><span>{externalChanges}</span></button>}<button type="button" className="settings-button icon-button" onClick={openSettings} aria-label="設定" title="設定"><Icon name="settings" /></button></header>
    <nav aria-label="圖庫工具列">
      <div className="filter-group" aria-label="篩選照片">{(["all", "unreviewed", "keep", "reject"] as const).map((nextFilter) => <button key={nextFilter} type="button" aria-pressed={filter === nextFilter} className={filter === nextFilter ? "active" : ""} onClick={() => setFilter(nextFilter)}>{nextFilter === "all" ? "全部 " + stats.all : labels[nextFilter] + " " + stats[nextFilter]}</button>)}</div>
      <label className="sr-only" htmlFor="photo-search">搜尋</label><input id="photo-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋" />
      <label className="sort-control"><span className="sr-only">排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortOption)}><option value="name-asc">檔名 A → Z</option><option value="name-desc">檔名 Z → A</option><option value="captured-newest">時間 ↓</option><option value="captured-oldest">時間 ↑</option><option value="rating-desc">星等 ↓</option></select></label>
    </nav>
    {settings ? <SettingsPage theme={theme} setTheme={setTheme} gridSize={gridSize} setGridSize={setGridSize} autoAdvance={autoAdvance} setAutoAdvance={setAutoAdvance} shortcuts={shortcuts} editingShortcut={editingShortcut} shortcutStatus={shortcutStatus} onClose={closeSettings} onStartShortcutEdit={startShortcutEdit} onRestoreShortcuts={restoreShortcuts} /> : !photos.length ? <section className="empty"><h1>選擇照片資料夾</h1><button type="button" className="primary icon-button" onClick={choose} aria-label="選擇照片資料夾" title="選擇照片資料夾"><Icon name="folder" /></button><p><kbd>Z</kbd>　<kbd>X</kbd>　<kbd>U</kbd>　<kbd>0–5</kbd>　<kbd>Space</kbd></p></section> : <>
      {view === "grid" ? <GalleryView root={root} gridMode={gridMode} libraryItems={libraryItems} gridViewportRef={gridViewportRef} gridBounds={gridBounds} rowCount={rowCount} cardHeight={cardHeight} firstRow={firstRow} columnCount={columnCount} virtualStart={virtualStart} virtualItems={virtualItems} galleryHeight={galleryHeight} galleryRows={galleryRows} firstGalleryRow={firstGalleryRow} lastGalleryRow={lastGalleryRow} burstByPhoto={burstByPhoto} selectedPaths={selectedPaths} comparison={comparison} active={active} onFocusPhoto={focusPhoto} onSelectPhoto={selectPhoto} onOpenLoupe={() => setView("loupe")} onScroll={handleGridScroll} onRememberRatio={rememberRatio} /> : view === "loupe" && current ? <LoupeView root={root} current={current} currentItem={currentItem} currentBurst={currentBurst} scale={loupeScale} pan={loupePan} stageRef={loupeStageRef} onStartPan={startLoupePan} onMovePan={moveLoupePan} onEndPan={endLoupePan} onScale={updateLoupeScale} onReset={resetLoupe} onRememberRatio={rememberRatio} onAddBurstToComparison={addBurstToComparison} /> : view === "compare" && comparisonPhotos.length >= 2 ? <CompareView root={root} photos={comparisonPhotos} zoom={compareZoom} pan={comparePan} onToggleZoom={() => { setCompareZoom((value) => !value); setComparePan({ x: 0, y: 0 }); }} onResetPan={() => setComparePan({ x: 0, y: 0 })} onReturnToGrid={() => setView("grid")} onRemove={toggleComparison} onStartPan={startComparePan} onMovePan={moveComparePan} onEndPan={endComparePan} /> : <section className="empty"><h1>{view === "compare" ? "至少加入兩張照片才能比較" : "沒有符合篩選的照片"}</h1><p>{view === "compare" ? "回到圖庫，以 C 將照片放入比較清單。" : "調整篩選條件或搜尋文字，繼續檢視圖庫。"}</p></section>}
      <section className="bottom-dock" aria-label="檢視與編輯控制">
        <div className="dock-view" aria-label="檢視方式"><button type="button" aria-pressed={view === "grid"} className={(view === "grid" ? "active " : "") + "icon-button"} onClick={() => setView("grid")} aria-label="圖庫" title="圖庫"><Icon name="grid" /></button><button type="button" aria-pressed={view === "loupe"} className={(view === "loupe" ? "active " : "") + "icon-button"} onClick={() => current && setView("loupe")} aria-label="單張" title="單張"><Icon name="single" /></button><button type="button" aria-pressed={view === "compare"} className={(view === "compare" ? "active " : "") + "icon-button has-count"} onClick={openComparison} aria-label={"比較 " + comparison.length + " 張"} title="比較"><Icon name="compare" /><span>{comparison.length}</span></button>{view === "grid" && <><button type="button" aria-pressed={gridMode === "square"} className={(gridMode === "square" ? "active " : "") + "icon-button"} onClick={() => setGridMode("square")} aria-label="正方形圖庫" title="正方形圖庫"><Icon name="square" /></button><button type="button" aria-pressed={gridMode === "photo"} className={(gridMode === "photo" ? "active " : "") + "icon-button"} onClick={() => setGridMode("photo")} aria-label="依相片比例" title="依相片比例"><Icon name="flow" /></button></>}</div>
        <div className="dock-actions"><div className="decision-controls" aria-label="目前選取照片的旗標"><button type="button" className={current?.decision === "keep" ? "keep selected" : "keep"} aria-pressed={current?.decision === "keep"} disabled={saving} onClick={() => void decision("keep")} aria-label="保留" title="保留 (Z)">Z</button><button type="button" className={current?.decision === "reject" ? "reject selected" : "reject"} aria-pressed={current?.decision === "reject"} disabled={saving} onClick={() => void decision("reject")} aria-label="淘汰" title="淘汰 (X)">X</button><button type="button" className={current?.decision === "unreviewed" ? "selected" : ""} aria-pressed={current?.decision === "unreviewed"} disabled={saving} onClick={() => void decision("unreviewed")} aria-label="清除旗標" title="清除旗標 (U)">U</button></div><div className="rating-controls" aria-label="目前選取照片的星等">{[0, 1, 2, 3, 4, 5].map((value) => <button key={value} type="button" aria-pressed={current?.rating === value} disabled={saving} onClick={() => void rating(value)} aria-label={value ? value + " 星" : "清除星等"} title={value ? value + " 星" : "清除星等"}>{value ? "★" + value : "0"}</button>)}</div><div className="compare-controls" aria-label="比較清單"><button type="button" className={current && comparison.includes(current.relativePath) ? "selected" : ""} aria-pressed={Boolean(current && comparison.includes(current.relativePath))} onClick={() => toggleComparison()} aria-label="加入或移出比較" title="加入或移出比較 (C)">C</button><button type="button" disabled={comparison.length < 2} onClick={openComparison} aria-label={"比較 " + comparison.length + " 張"} title="比較"><Icon name="compare" /><span>{comparison.length}</span></button></div></div>
        {view === "grid" && <label className="dock-zoom">縮放 <input aria-label="圖庫縮圖尺寸" type="range" min="120" max="340" step="10" value={gridSize} onChange={(event) => setGridSize(Number(event.target.value))} /></label>}
      </section>
    </>}
    {toast && <div className="shortcut-toast" role="status" aria-live="polite">{toast}</div>}
    <footer aria-live="polite"><span>{status}</span>{photos.length > 0 && <span className="progress">{selectedItemCount > 0 && <>{selectedItemCount} 已選　</>}{reviewed === stats.all ? <>第一輪完成 · <button onClick={() => setFilter("reject")}>檢查淘汰</button><button onClick={() => setFilter("keep")}>檢視保留</button></> : <>{reviewed} 已審 · {stats.unreviewed} 待審　{current ? active + 1 + " / " + libraryItems.length : ""}</>}</span>}</footer>
  </main>;
}
