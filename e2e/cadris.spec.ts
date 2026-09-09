import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const root = "/library";
    const photos = [
      { path: `${root}/one.JPG`, relativePath: "one.JPG", name: "one.JPG", extension: "JPG", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 },
      { path: `${root}/two.RAF`, relativePath: "two.RAF", name: "two.RAF", extension: "RAF", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 },
      { path: `${root}/three.JPG`, relativePath: "three.JPG", name: "three.JPG", extension: "JPG", size: 1000, modifiedAt: 1, decision: "unreviewed", rating: 0 },
    ];
    let callbackId = 0;
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: { variant?: string }) => Promise<unknown>; transformCallback: () => number; unregisterCallback: () => void }; __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void } };
    host.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === "plugin:dialog|open") return root;
        if (command === "scan_library") return photos;
        if (command === "thumbnail_for") return `cadris-photo://localhost/${args?.variant ?? "grid"}`;
        if (command === "save_decisions_batch") return { nativeSynced: 0, pendingNativeSync: 1 };
        if (command === "save_ratings_batch" || command === "watch_library") return undefined;
        if (command === "plugin:event|listen") return ++callbackId;
        return undefined;
      },
      transformCallback: () => ++callbackId,
      unregisterCallback: () => undefined,
    };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  });
});

test("selects photos with keyboard workflow and opens a RAW original preview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "開啟照片資料夾" }).click();
  const gallery = page.getByRole("listbox", { name: "照片選取清單" });
  const photos = gallery.getByRole("option");
  await expect(photos).toHaveCount(3);
  await photos.nth(0).click();
  await photos.nth(1).click({ modifiers: ["Meta"] });
  await expect(photos.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(photos.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("z");
  await expect(page.getByText(/Finder 標籤會自動重試同步/)).toBeVisible();
  await page.getByRole("option", { name: /two\.RAF/ }).dblclick();
  await expect(page.getByRole("heading", { name: "two.RAF" })).toBeVisible();
});
