import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GalleryView } from "./GalleryView";
import type { LibraryItem, Photo } from "../lib/photos";

const photo = (relativePath: string): Photo => ({ path: `/library/${relativePath}`, relativePath, name: relativePath, extension: "JPG", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 });
const items: LibraryItem[] = ["one.JPG", "two.JPG"].map((relativePath) => ({ key: relativePath, kind: "photo", primary: photo(relativePath), photos: [photo(relativePath)] }));

describe("GalleryView", () => {
  it("uses a multi-select listbox with a single roving tab stop", () => {
    const select = vi.fn();
    render(<GalleryView root="/library" gridMode="square" libraryItems={items} gridViewportRef={{ current: null }} gridBounds={{ width: 500, height: 500 }} rowCount={2} cardHeight={200} firstRow={0} columnCount={1} virtualStart={0} virtualItems={items} galleryHeight={0} galleryRows={[]} firstGalleryRow={0} lastGalleryRow={0} burstByPhoto={new Map()} selectedPaths={new Set(["one.JPG"])} comparison={[]} active={0} onFocusPhoto={vi.fn()} onSelectPhoto={select} onOpenLoupe={vi.fn()} onScroll={vi.fn()} onRememberRatio={vi.fn()} />);
    const listbox = screen.getByRole("listbox", { name: "照片選取清單" });
    const options = screen.getAllByRole("option");
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    expect(options[0]).toHaveAttribute("tabindex", "0");
    expect(options[1]).toHaveAttribute("tabindex", "-1");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(options[1], { metaKey: true });
    expect(select).toHaveBeenCalledWith(1, expect.objectContaining({ metaKey: true }));
  });
});
