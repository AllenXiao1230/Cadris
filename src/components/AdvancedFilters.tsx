import type { Photo } from "../lib/photos";

export type AdvancedFilter = {
  camera: string;
  lens: string;
  focal: string;
  iso: string;
  aperture: string;
  dateFrom: string;
  dateTo: string;
  minRating: string;
  minSize: string;
  maxSize: string;
  burstOnly: boolean;
  pairedOnly: boolean;
  preview: "all" | "ready" | "failed";
  assistance: "all" | "blur" | "exposure" | "similar";
};

export const emptyAdvancedFilter: AdvancedFilter = { camera: "", lens: "", focal: "", iso: "", aperture: "", dateFrom: "", dateTo: "", minRating: "", minSize: "", maxSize: "", burstOnly: false, pairedOnly: false, preview: "all", assistance: "all" };

type Props = {
  value: AdvancedFilter;
  photos: Photo[];
  onChange: (value: AdvancedFilter) => void;
  onReset: () => void;
  onSmartCollection: (value: string) => void;
};

const values = (photos: Photo[], key: "camera" | "lens") => [...new Set(photos.map((photo) => photo[key]).filter((value): value is string => Boolean(value)))].sort();

export function AdvancedFilters({ value, photos, onChange, onReset, onSmartCollection }: Props) {
  const update = <K extends keyof AdvancedFilter>(key: K, next: AdvancedFilter[K]) => onChange({ ...value, [key]: next });
  return <section className="advanced-filters" aria-label="進階篩選">
    <div className="advanced-filter-row">
      <label>智慧集合<select defaultValue="" onChange={(event) => { onSmartCollection(event.target.value); event.currentTarget.value = ""; }}><option value="">套用…</option><option value="unreviewed">待審照片</option><option value="keep">保留照片</option><option value="reject">淘汰照片</option><option value="burst">連拍</option><option value="pair">RAW 配對</option><option value="rated">已評等</option><option value="assistance">需要人工確認</option></select></label>
      <label>相機<select value={value.camera} onChange={(event) => update("camera", event.target.value)}><option value="">全部</option>{values(photos, "camera").map((camera) => <option key={camera}>{camera}</option>)}</select></label>
      <label>鏡頭<select value={value.lens} onChange={(event) => update("lens", event.target.value)}><option value="">全部</option>{values(photos, "lens").map((lens) => <option key={lens}>{lens}</option>)}</select></label>
      <label>日期<input type="date" value={value.dateFrom} onChange={(event) => update("dateFrom", event.target.value)} /></label>
      <label>至<input type="date" value={value.dateTo} onChange={(event) => update("dateTo", event.target.value)} /></label>
      <label>最低星等<select value={value.minRating} onChange={(event) => update("minRating", event.target.value)}><option value="">不限</option>{[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}★</option>)}</select></label>
    </div>
    <div className="advanced-filter-row">
      <label>焦段<input value={value.focal} onChange={(event) => update("focal", event.target.value)} placeholder="例如 35" /></label>
      <label>ISO<input value={value.iso} onChange={(event) => update("iso", event.target.value)} placeholder="例如 800" /></label>
      <label>光圈<input value={value.aperture} onChange={(event) => update("aperture", event.target.value)} placeholder="例如 F2" /></label>
      <label>大小 MB<input inputMode="decimal" value={value.minSize} onChange={(event) => update("minSize", event.target.value)} placeholder="最小" /></label>
      <label>至<input inputMode="decimal" value={value.maxSize} onChange={(event) => update("maxSize", event.target.value)} placeholder="最大" /></label>
      <label>預覽<select value={value.preview} onChange={(event) => update("preview", event.target.value as AdvancedFilter["preview"])}><option value="all">全部</option><option value="ready">可用</option><option value="failed">失敗</option></select></label>
      <label>提示<select value={value.assistance} onChange={(event) => update("assistance", event.target.value as AdvancedFilter["assistance"])}><option value="all">全部</option><option value="blur">模糊</option><option value="exposure">曝光</option><option value="similar">相似</option></select></label>
      <label className="compact-toggle"><input type="checkbox" checked={value.burstOnly} onChange={(event) => update("burstOnly", event.target.checked)} />連拍</label>
      <label className="compact-toggle"><input type="checkbox" checked={value.pairedOnly} onChange={(event) => update("pairedOnly", event.target.checked)} />RAW 配對</label>
      <button type="button" onClick={onReset}>清除條件</button>
    </div>
  </section>;
}
