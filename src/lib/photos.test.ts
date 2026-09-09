import { describe, expect, it } from "vitest";
import { buildBurstGroups, buildLibraryItems, selectionForItem, type Photo } from "./photos";

const photo = (relativePath: string, extension = "JPG", capturedAt?: string): Photo => ({ path: `/library/${relativePath}`, relativePath, name: relativePath.split("/").at(-1)!, extension, size: 1000, modifiedAt: 1, capturedAt, decision: "unreviewed", rating: 0 });

describe("photo library model", () => {
  it("keeps RAW and rendered partners in one selection item", () => {
    const items = buildLibraryItems([photo("set/frame.RAF", "RAF"), photo("set/frame.JPG")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "pair", primary: { extension: "JPG" } });
  });

  it("supports single, Command and Shift selection without splitting a pair", () => {
    const items = buildLibraryItems([photo("a.JPG"), photo("b.RAF", "RAF"), photo("b.JPG"), photo("c.JPG")]);
    const first = selectionForItem(items, 0, [], null, {});
    const command = selectionForItem(items, 1, first.selection, first.anchor, { metaKey: true });
    const range = selectionForItem(items, 2, command.selection, command.anchor, { shiftKey: true, metaKey: true });
    expect(first.selection).toEqual(["a.JPG"]);
    expect(command.selection).toEqual(expect.arrayContaining(["a.JPG", "b.RAF", "b.JPG"]));
    expect(range.selection).toEqual(expect.arrayContaining(["a.JPG", "b.RAF", "b.JPG", "c.JPG"]));
  });

  it("groups adjacent timestamped frames as a burst", () => {
    const items = buildLibraryItems([
      photo("burst/01.JPG", "JPG", "2026:09:09 12:00:00"),
      photo("burst/02.JPG", "JPG", "2026:09:09 12:00:01"),
      photo("burst/03.JPG", "JPG", "2026:09:09 12:00:02"),
    ]);
    expect(buildBurstGroups(items)[0].photos).toHaveLength(3);
  });
});
