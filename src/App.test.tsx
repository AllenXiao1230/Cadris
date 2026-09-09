import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return Promise.resolve(() => mocks.listeners.delete(name));
  }),
}));

const root = "/library";
const photos = [
  { path: `${root}/one.JPG`, relativePath: "one.JPG", name: "one.JPG", extension: "JPG", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 },
  { path: `${root}/two.RAF`, relativePath: "two.RAF", name: "two.RAF", extension: "RAF", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 },
  { path: `${root}/three.JPG`, relativePath: "three.JPG", name: "three.JPG", extension: "JPG", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 },
];

async function openLibrary() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "開啟照片資料夾" })); });
  await within(await screen.findByRole("listbox", { name: "照片選取清單" })).findAllByRole("option");
}

describe("Cadris library workflow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.listeners.clear();
    mocks.open.mockResolvedValue(root);
    mocks.invoke.mockImplementation((command: string, args?: { variant?: string }) => {
      if (command === "scan_library") return Promise.resolve(photos);
      if (command === "watch_library") return Promise.resolve();
      if (command === "thumbnail_for") return Promise.resolve(`cadris-photo://localhost/${args?.variant ?? "grid"}`);
      if (command === "search_library") return Promise.resolve([]);
      if (command === "save_decisions_batch") return Promise.resolve({ nativeSynced: 0, pendingNativeSync: 1 });
      if (command === "save_ratings_batch") return Promise.resolve();
      return Promise.resolve();
    });
  });

  it("selects a range, reports pending Finder synchronization, and enters RAW original preview", async () => {
    render(<App />);
    await openLibrary();
    const options = within(screen.getByRole("listbox", { name: "照片選取清單" })).getAllByRole("option");
    fireEvent.click(options[0]);
    fireEvent.click(options[1], { metaKey: true });
    fireEvent.click(options[2], { shiftKey: true, metaKey: true });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "照片選取清單" })).getAllByRole("option", { selected: true })).toHaveLength(3));
    fireEvent.keyDown(window, { key: "z" });
    await screen.findByText(/Finder 標籤會自動重試同步/);
    fireEvent.doubleClick(options[1]);
    await screen.findByRole("heading", { name: "two.RAF" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("thumbnail_for", expect.objectContaining({ variant: "original", relativePath: "two.RAF" })));
  });

  it("keeps a failed batch write local-only and tells the user to retry", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "scan_library") return Promise.resolve(photos);
      if (command === "watch_library" || command === "thumbnail_for") return Promise.resolve("cadris-photo://localhost/grid");
      if (command === "save_decisions_batch") return Promise.reject(new Error("write failed"));
      return Promise.resolve();
    });
    render(<App />);
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await screen.findByText("旗標尚未保存。請確認圖庫與照片可寫入，然後再試一次。");
  });

  it("shows an explicit refresh affordance for external library changes", async () => {
    render(<App />);
    await openLibrary();
    await act(async () => { mocks.listeners.get("cadris://library-changed")?.({ payload: { root, paths: ["one.JPG"] } }); });
    expect(await screen.findByRole("button", { name: "1 項外部更新，重新整理" })).toBeVisible();
  });
});
