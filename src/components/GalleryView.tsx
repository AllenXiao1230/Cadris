import type { MouseEvent, RefObject, UIEvent } from "react";
import { CachedPhotoImage } from "./CachedPhotoImage";
import { GRID_PADDING, labels, optionId, ratingLabel, type BurstGroup, type GalleryItem, type GalleryRow, type LibraryItem, type Photo } from "../lib/photos";

type BurstInfo = { position: number; total: number; group: BurstGroup };
type GalleryViewProps = {
  root: string;
  gridMode: "square" | "photo";
  libraryItems: LibraryItem[];
  gridViewportRef: RefObject<HTMLElement | null>;
  gridBounds: { width: number; height: number };
  rowCount: number;
  cardHeight: number;
  firstRow: number;
  columnCount: number;
  virtualStart: number;
  virtualItems: LibraryItem[];
  galleryHeight: number;
  galleryRows: GalleryRow[];
  firstGalleryRow: number;
  lastGalleryRow: number;
  burstByPhoto: Map<string, BurstInfo>;
  selectedPaths: Set<string>;
  comparison: string[];
  active: number;
  onFocusPhoto: (index: number) => void;
  onSelectPhoto: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onOpenLoupe: () => void;
  onScroll: (event: UIEvent<HTMLElement>) => void;
  onRememberRatio: (relativePath: string, image: HTMLImageElement) => void;
};

function Card({ root, item, index, burst, isSelected, isCompared, isActive, square, width, onFocusPhoto, onSelectPhoto, onOpenLoupe, onRememberRatio }: {
  root: string;
  item: LibraryItem;
  index: number;
  burst?: BurstInfo;
  isSelected: boolean;
  isCompared: boolean;
  isActive: boolean;
  square: boolean;
  width?: number;
  onFocusPhoto: (index: number) => void;
  onSelectPhoto: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onOpenLoupe: () => void;
  onRememberRatio: (relativePath: string, image: HTMLImageElement) => void;
}) {
  const photo = item.primary;
  const className = `${square ? "card square-card" : "photo-card"} ${photo.decision}${isActive ? " selected" : ""}${isSelected ? " multi-selected" : ""}${isCompared ? " compare-selected" : ""}`;
  const label = `${photo.name}，${labels[photo.decision]}，${ratingLabel(photo.rating)}${item.kind === "pair" ? "，RAW 與 JPEG 配對" : ""}${burst ? `，連拍 ${burst.position + 1} / ${burst.total}` : ""}${isSelected ? "，已選取" : ""}${isCompared ? "，已加入比較" : ""}${isActive ? "，目前照片" : ""}`;
  return <button type="button" id={optionId(photo.relativePath)} role="option" tabIndex={isActive ? 0 : -1} className={className} style={width ? { flexBasis: width } : undefined} aria-label={label} aria-selected={isSelected} onFocus={() => onFocusPhoto(index)} onClick={(event) => onSelectPhoto(index, event)} onDoubleClick={onOpenLoupe}><CachedPhotoImage root={root} photo={photo} alt="" loading="lazy" onLoad={(event) => onRememberRatio(photo.relativePath, event.currentTarget)} />{item.kind === "pair" && <span className="group-badge">RAW + JPEG · {item.photos.length}</span>}{burst && <span className="burst-badge">連拍 {burst.position + 1} / {burst.total}</span>}{square ? <div className="square-info"><small>{item.kind === "pair" ? item.photos.map((member) => member.extension).join(" + ") : photo.extension}</small></div> : photo.decision !== "unreviewed" && <span className="photo-status">{labels[photo.decision]}</span>}</button>;
}

function getCardState(item: LibraryItem, index: number, props: Pick<GalleryViewProps, "burstByPhoto" | "selectedPaths" | "comparison" | "active">) {
  const photo = item.primary;
  return {
    burst: props.burstByPhoto.get(photo.relativePath),
    isSelected: item.photos.every((member) => props.selectedPaths.has(member.relativePath)),
    isCompared: props.comparison.includes(photo.relativePath),
    isActive: index === props.active,
  };
}

export function GalleryView(props: GalleryViewProps) {
  const shared = { root: props.root, onFocusPhoto: props.onFocusPhoto, onSelectPhoto: props.onSelectPhoto, onOpenLoupe: props.onOpenLoupe, onRememberRatio: props.onRememberRatio };
  if (props.gridMode === "square") {
    return <section className="grid-viewport" ref={props.gridViewportRef} aria-label={`${props.libraryItems.length} 個圖庫項目的正方形圖庫`} onScroll={props.onScroll}><div className="grid-spacer" style={{ height: Math.max(props.gridBounds.height, props.rowCount * props.cardHeight + GRID_PADDING * 2) }}><div className="grid square-grid" role="listbox" aria-label="照片選取清單" aria-multiselectable="true" style={{ top: props.firstRow * props.cardHeight + GRID_PADDING, left: GRID_PADDING, right: GRID_PADDING, gridTemplateColumns: `repeat(${props.columnCount}, minmax(0, 1fr))`, gridAutoRows: `${props.cardHeight}px` }}>
      {props.virtualItems.map((item, offset) => {
        const index = props.virtualStart + offset;
        return <Card key={item.key} item={item} index={index} square {...shared} {...getCardState(item, index, props)} />;
      })}
    </div></div></section>;
  }

  return <section className="grid-viewport" ref={props.gridViewportRef} aria-label={`${props.libraryItems.length} 個圖庫項目的照片格點`} onScroll={props.onScroll}><div className="photo-gallery-spacer" style={{ height: Math.max(props.gridBounds.height, props.galleryHeight) }}><div className="photo-gallery" role="listbox" aria-label="照片選取清單" aria-multiselectable="true" style={{ top: props.galleryRows[props.firstGalleryRow]?.top ?? GRID_PADDING, left: GRID_PADDING, right: GRID_PADDING }}>{props.galleryRows.slice(props.firstGalleryRow, props.lastGalleryRow).map((row: GalleryRow) => <div className="photo-row" key={row.top} style={{ height: row.height }}>{row.items.map((entry: GalleryItem) => <Card key={entry.item.key} item={entry.item} index={entry.index} width={entry.width} square={false} {...shared} {...getCardState(entry.item, entry.index, props)} />)}</div>)}</div></div></section>;
}

export type { Photo };
