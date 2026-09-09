import type { PointerEvent } from "react";
import { CachedPhotoImage } from "./CachedPhotoImage";
import { labels, ratingLabel, type Photo } from "../lib/photos";

type CompareViewProps = {
  root: string;
  photos: Photo[];
  zoom: boolean;
  pan: { x: number; y: number };
  onToggleZoom: () => void;
  onResetPan: () => void;
  onReturnToGrid: () => void;
  onRemove: (photo: Photo) => void;
  onStartPan: (event: PointerEvent<HTMLDivElement>) => void;
  onMovePan: (event: PointerEvent<HTMLDivElement>) => void;
  onEndPan: (event: PointerEvent<HTMLDivElement>) => void;
};

export function CompareView({ root, photos, zoom, pan, onToggleZoom, onResetPan, onReturnToGrid, onRemove, onStartPan, onMovePan, onEndPan }: CompareViewProps) {
  return <section className="compare" aria-label={`${photos.length} 張照片的比較檢視`}><div className="compare-toolbar"><div><strong>比較 {photos.length} 張</strong><span>Space 同步縮放 · 拖曳同步平移</span></div><div><button type="button" aria-pressed={zoom} onClick={onToggleZoom}>{zoom ? "整張檢視" : "細節 180%"}</button><button type="button" onClick={onResetPan}>置中</button><button type="button" onClick={onReturnToGrid}>回到圖庫</button></div></div><div className={`compare-grid count-${photos.length}`}>{photos.map((photo) => <article className="compare-pane" key={photo.relativePath}><header><span>{photo.name}</span><button type="button" onClick={() => onRemove(photo)}>移出</button></header><div className={zoom ? "compare-stage zoomed" : "compare-stage"} onPointerDown={onStartPan} onPointerMove={onMovePan} onPointerUp={onEndPan} onPointerCancel={onEndPan}><CachedPhotoImage root={root} photo={photo} alt={photo.name} draggable={false} style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom ? 1.8 : 1})` }} /></div><footer><span>{photo.extension} · {ratingLabel(photo.rating)}</span><span>{labels[photo.decision]}</span></footer></article>)}</div></section>;
}
