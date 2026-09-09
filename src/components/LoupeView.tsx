import type { PointerEvent, RefObject } from "react";
import { CachedPhotoImage } from "./CachedPhotoImage";
import { bytes, labels, LOUPE_MAX_SCALE, LOUPE_MIN_SCALE, ratingLabel, type BurstGroup, type Decision, type LibraryItem, type Photo } from "../lib/photos";

type BurstInfo = { position: number; total: number; group: BurstGroup };
type LoupeViewProps = {
  root: string;
  current: Photo;
  currentItem?: LibraryItem;
  currentBurst?: BurstInfo;
  isBurstBest: boolean;
  history: { id: number; previousDecision: Decision; nextDecision: Decision; previousRating: number; nextRating: number }[];
  scale: number;
  pan: { x: number; y: number };
  stageRef: RefObject<HTMLDivElement | null>;
  onStartPan: (event: PointerEvent<HTMLDivElement>) => void;
  onMovePan: (event: PointerEvent<HTMLDivElement>) => void;
  onEndPan: (event: PointerEvent<HTMLDivElement>) => void;
  onScale: (scale: number) => void;
  onReset: () => void;
  onRememberRatio: (relativePath: string, image: HTMLImageElement) => void;
  onAddBurstToComparison: () => void;
  onMarkBurstBest: () => void;
  onRestoreHistory: (entry: { id: number; previousDecision: Decision; nextDecision: Decision; previousRating: number; nextRating: number }) => void;
};

export function LoupeView({ root, current, currentItem, currentBurst, isBurstBest, history, scale, pan, stageRef, onStartPan, onMovePan, onEndPan, onScale, onReset, onRememberRatio, onAddBurstToComparison, onMarkBurstBest, onRestoreHistory }: LoupeViewProps) {
  return <section className="loupe"><div className={scale > LOUPE_MIN_SCALE ? "stage zoomed" : "stage"} ref={stageRef} onPointerDown={onStartPan} onPointerMove={onMovePan} onPointerUp={onEndPan} onPointerCancel={onEndPan} onWheel={(event) => { event.preventDefault(); onScale(scale + (event.deltaY < 0 ? 0.15 : -0.15)); }}><CachedPhotoImage root={root} photo={current} className="loupe-image" alt={current.name} draggable={false} onLoad={(event) => onRememberRatio(current.relativePath, event.currentTarget)} style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})` }} /><div className="loupe-controls" aria-label="照片縮放控制" onPointerDown={(event) => event.stopPropagation()}><button type="button" onClick={() => onScale(scale - 0.2)}>縮小</button><label>縮放 <input aria-label="單張照片縮放比例" type="range" min={LOUPE_MIN_SCALE} max={LOUPE_MAX_SCALE} step="0.1" value={scale} onChange={(event) => onScale(Number(event.target.value))} /></label><output>{Math.round(scale * 100)}%</output><button type="button" onClick={() => onScale(scale + 0.2)}>放大</button><button type="button" onClick={onReset}>置中</button></div></div><aside><label className={current.decision}>{labels[current.decision]}</label><h2>{current.name}</h2><p>{current.relativePath}</p>{currentItem?.kind === "pair" && <section className="pair-summary"><b>RAW + JPEG 配對 · {currentItem.photos.length} 個檔案</b><p>旗標與星等會一起套用，原始檔不會被移動或刪除。</p></section>}{currentBurst && <section className="burst-summary"><b>連拍組 · 第 {currentBurst.position + 1} / {currentBurst.total} 張{isBurstBest ? " · 最佳" : ""}</b><div><button type="button" onClick={onAddBurstToComparison}>加入比較</button><button type="button" onClick={onMarkBurstBest}>{isBurstBest ? "目前最佳" : "指定最佳"}</button></div></section>}<dl><dt>格式</dt><dd>{current.extension}</dd><dt>大小</dt><dd>{bytes(current.size)}</dd><dt>拍攝時間</dt><dd>{current.capturedAt ?? "—"}</dd><dt>相機</dt><dd>{current.camera ?? "—"}</dd><dt>鏡頭</dt><dd>{current.lens ?? "—"}</dd><dt>曝光</dt><dd>{current.exposure ?? "—"}</dd><dt>星等</dt><dd>{ratingLabel(current.rating)}</dd></dl>{history.length > 0 && <section className="history-summary"><b>決策歷程</b>{history.slice(0, 4).map((entry) => <div key={entry.id}><span>{labels[entry.previousDecision]} → {labels[entry.nextDecision]} · {entry.previousRating}★ → {entry.nextRating}★</span><button type="button" onClick={() => onRestoreHistory(entry)}>還原</button></div>)}</section>}<p>Space：切換 100% 細節<br />可拖曳照片、滾輪或滑桿縮放<br />C：加入比較　← →：前後張　G：圖庫</p></aside></section>;
}
