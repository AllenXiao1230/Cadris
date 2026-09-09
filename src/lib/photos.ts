export type Decision = "unreviewed" | "keep" | "reject";
export type View = "grid" | "loupe" | "compare";
export type SortOption = "name-asc" | "name-desc" | "captured-newest" | "captured-oldest" | "rating-desc";
export type ShortcutAction = "keep" | "reject" | "unreviewed" | "rating-0" | "rating-1" | "rating-2" | "rating-3" | "rating-4" | "rating-5" | "previous" | "next" | "toggle-view" | "grid" | "compare-toggle" | "zoom-out" | "zoom-in";
export type ShortcutMap = Record<ShortcutAction, string>;
export type Photo = {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: number;
  camera?: string;
  lens?: string;
  capturedAt?: string;
  exposure?: string;
  focalLength?: string;
  exposureCompensation?: string;
  dimensions?: string;
  shooting?: string;
  orientation?: string;
  decision: Decision;
  rating: number;
  ratio?: number;
};
export type BatchDecisionSaveResult = { nativeSynced: number; pendingNativeSync: number };
export type LastAction = {
  photos: (Pick<Photo, "relativePath" | "name"> & { before: Decision | number })[];
  field: "decision" | "rating";
  after: Decision | number;
};
export type LibraryItem = { key: string; kind: "photo" | "pair"; primary: Photo; photos: Photo[] };
export type GalleryItem = { item: LibraryItem; index: number; ratio: number; width: number };
export type GalleryRow = { items: GalleryItem[]; height: number; top: number };
export type BurstGroup = { id: string; photos: Photo[] };
export type LibraryChange = { root: string; paths: string[] };
export type ScanUpdate = { root: string; phase: string; processed: number; total: number; photos: Photo[] };
export type ThumbnailVariant = "grid" | "detail" | "original";
export type Theme = "midnight" | "graphite" | "warm";
export type SelectionModifiers = { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };

export const labels: Record<Decision, string> = { unreviewed: "未審", keep: "保留", reject: "淘汰" };
export const defaultShortcuts: ShortcutMap = {
  keep: "Z", reject: "X", unreviewed: "U", "rating-0": "0", "rating-1": "1", "rating-2": "2", "rating-3": "3", "rating-4": "4", "rating-5": "5",
  previous: "ArrowLeft", next: "ArrowRight", "toggle-view": "Space", grid: "G", "compare-toggle": "C", "zoom-out": "-", "zoom-in": "=",
};
export const shortcutGroups: { title: string; actions: { action: ShortcutAction; label: string }[] }[] = [
  { title: "旗標", actions: [{ action: "keep", label: "保留" }, { action: "reject", label: "淘汰" }, { action: "unreviewed", label: "清除旗標" }] },
  { title: "星等", actions: [0, 1, 2, 3, 4, 5].map((rating) => ({ action: (`rating-${rating}`) as ShortcutAction, label: rating ? `${rating} 星` : "清除評等" })) },
  { title: "檢視與導覽", actions: [{ action: "previous", label: "上一張" }, { action: "next", label: "下一張" }, { action: "toggle-view", label: "開啟單張／縮放細節" }, { action: "grid", label: "圖庫檢視" }, { action: "compare-toggle", label: "加入／移出比較" }, { action: "zoom-out", label: "縮小圖庫" }, { action: "zoom-in", label: "放大圖庫" }] },
];
export const GRID_GAP = 14;
export const GRID_PADDING = 20;
export const LOUPE_MIN_SCALE = 1;
export const LOUPE_MAX_SCALE = 4;
export const RAW_EXTENSIONS = new Set(["ARW", "CR3", "CR2", "DNG", "NEF", "RAF", "ORF", "RW2"]);
export const RENDERED_EXTENSIONS = new Set(["JPG", "JPEG", "HEIC", "HEIF", "PNG", "TIFF", "TIF", "WEBP"]);
export const themeLabels: Record<Theme, string> = { midnight: "午夜藍", graphite: "石墨", warm: "暖灰" };

export function loadTheme(): Theme {
  try {
    const value = window.localStorage.getItem("cadris.theme");
    return value === "graphite" || value === "warm" || value === "midnight" ? value : "midnight";
  } catch { return "midnight"; }
}

export const bytes = (value: number) => value > 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1000))} KB`;
export const ratingLabel = (value: number) => value ? `${value} / 5 星` : "未評等";
export const captureTime = (value?: string) => value ? Date.parse(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")) || 0 : 0;
export const normalizeShortcut = (key: string) => key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
export const shortcutLabel = (key: string) => ({ ArrowLeft: "←", ArrowRight: "→", Space: "Space", Escape: "Esc" }[key] ?? key);

export const loadShortcuts = (): ShortcutMap => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("cadris.shortcuts") ?? "{}") as Partial<ShortcutMap>;
    const shortcuts = { ...defaultShortcuts, ...saved };
    return Object.keys(defaultShortcuts).every((action) => typeof shortcuts[action as ShortcutAction] === "string") && new Set(Object.values(shortcuts)).size === Object.keys(defaultShortcuts).length ? shortcuts : defaultShortcuts;
  } catch { return defaultShortcuts; }
};

export const rowAt = (rows: GalleryRow[], position: number) => {
  let low = 0;
  let high = rows.length - 1;
  let answer = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].top <= position) { answer = middle; low = middle + 1; } else high = middle - 1;
  }
  return answer;
};

const photoPairKey = (photo: Photo) => {
  const slash = photo.relativePath.lastIndexOf("/");
  const folder = slash >= 0 ? photo.relativePath.slice(0, slash) : "";
  const stem = photo.name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
  return `${folder}/${stem}`;
};

export function buildLibraryItems(photos: Photo[]): LibraryItem[] {
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
    items.push({ key: `pair:${key}`, kind: "pair", primary, photos: pair });
  });
  return items;
}

export function buildBurstGroups(items: LibraryItem[]): BurstGroup[] {
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
      if (sequence.length >= 3) groups.push({ id: `burst:${folder}:${sequence[0].timestamp}`, photos: sequence.map((entry) => entry.photo) });
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

export function selectionForItem(items: LibraryItem[], index: number, selection: string[], anchor: number | null, modifiers: SelectionModifiers) {
  const item = items[index];
  if (!item) return { selection, anchor };
  const selected = new Set(selection);
  const paths = item.photos.map((photo) => photo.relativePath);
  if (modifiers.shiftKey && anchor !== null) {
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    const range = items.slice(start, end + 1).flatMap((entry) => entry.photos.map((photo) => photo.relativePath));
    return { selection: modifiers.metaKey || modifiers.ctrlKey ? Array.from(new Set([...selection, ...range])) : range, anchor };
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    const allSelected = paths.every((path) => selected.has(path));
    paths.forEach((path) => allSelected ? selected.delete(path) : selected.add(path));
    return { selection: [...selected], anchor: index };
  }
  return { selection: paths, anchor: index };
}

export const optionId = (relativePath: string) => `photo-option-${relativePath.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
