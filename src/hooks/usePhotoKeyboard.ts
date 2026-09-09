import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { LOUPE_MIN_SCALE, normalizeShortcut, shortcutGroups, shortcutLabel, type Decision, type ShortcutAction, type ShortcutMap, type View } from "../lib/photos";

type UsePhotoKeyboardOptions = {
  editingShortcut: ShortcutAction | null;
  setEditingShortcut: Dispatch<SetStateAction<ShortcutAction | null>>;
  shortcuts: ShortcutMap;
  setShortcuts: Dispatch<SetStateAction<ShortcutMap>>;
  setShortcutStatus: Dispatch<SetStateAction<string>>;
  settings: boolean;
  selection: string[];
  setSelection: Dispatch<SetStateAction<string[]>>;
  setSelectionAnchor: Dispatch<SetStateAction<number | null>>;
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  hasCurrent: boolean;
  loupeScale: number;
  resetLoupe: () => void;
  updateLoupeScale: (scale: number) => void;
  setCompareZoom: Dispatch<SetStateAction<boolean>>;
  setComparePan: Dispatch<SetStateAction<{ x: number; y: number }>>;
  move: (direction: number) => void;
  toggleComparison: () => void;
  decision: (decision: Decision, fromShortcut?: boolean) => Promise<void>;
  rating: (rating: number, fromShortcut?: boolean) => Promise<void>;
  undo: () => Promise<void>;
  gridSize: number;
  setGridSize: Dispatch<SetStateAction<number>>;
  notify: (message: string) => void;
};

export function usePhotoKeyboard(initialOptions: UsePhotoKeyboardOptions) {
  const optionsRef = useRef(initialOptions);
  optionsRef.current = initialOptions;

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const options = optionsRef.current;
      const target = event.target;
      if (options.editingShortcut) {
        event.preventDefault();
        const pressed = normalizeShortcut(event.key);
        if (pressed === "Escape") { options.setEditingShortcut(null); options.setShortcutStatus("已取消設定快捷鍵。"); return; }
        if (["Meta", "Control", "Alt", "Shift"].includes(pressed)) return;
        const conflict = Object.entries(options.shortcuts).find(([action, value]) => action !== options.editingShortcut && value === pressed);
        if (conflict) {
          const name = shortcutGroups.flatMap((group) => group.actions).find((item) => item.action === conflict[0])?.label;
          options.setShortcutStatus(`「${shortcutLabel(pressed)}」已用於「${name}」。請選擇其他按鍵。`);
          return;
        }
        const label = shortcutGroups.flatMap((group) => group.actions).find((item) => item.action === options.editingShortcut)?.label;
        options.setShortcuts((current) => ({ ...current, [options.editingShortcut!]: pressed }));
        options.setShortcutStatus(`已將「${label}」設為「${shortcutLabel(pressed)}」。`);
        options.setEditingShortcut(null);
        return;
      }
      if (target instanceof HTMLElement && target.matches("input,textarea,select")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); void options.undo(); return; }
      if (options.settings) return;
      const pressed = normalizeShortcut(event.key);
      if (pressed === "Escape" && options.selection.length) { event.preventDefault(); options.setSelection([]); options.setSelectionAnchor(null); options.notify("已清除選取"); return; }
      if (pressed === options.shortcuts.previous) { event.preventDefault(); options.move(-1); options.notify(`${shortcutLabel(pressed)}　上一張`); }
      if (pressed === options.shortcuts.next) { event.preventDefault(); options.move(1); options.notify(`${shortcutLabel(pressed)}　下一張`); }
      if (pressed === options.shortcuts["toggle-view"]) {
        event.preventDefault();
        if (options.view === "grid" && options.hasCurrent) { options.setView("loupe"); options.notify(`${shortcutLabel(pressed)}　單張檢視`); }
        else if (options.view === "loupe") { if (options.loupeScale > LOUPE_MIN_SCALE) options.resetLoupe(); else options.updateLoupeScale(2); options.notify(`${shortcutLabel(pressed)}　切換細節縮放`); }
        else if (options.view === "compare") { options.setCompareZoom((value) => !value); options.setComparePan({ x: 0, y: 0 }); options.notify(`${shortcutLabel(pressed)}　同步細節縮放`); }
      }
      if (pressed === options.shortcuts.grid) { event.preventDefault(); options.setView("grid"); options.resetLoupe(); options.notify(`${shortcutLabel(pressed)}　圖庫檢視`); }
      if (pressed === options.shortcuts["compare-toggle"]) { event.preventDefault(); options.toggleComparison(); }
      if (pressed === options.shortcuts.keep) void options.decision("keep", true);
      if (pressed === options.shortcuts.reject) void options.decision("reject", true);
      if (pressed === options.shortcuts.unreviewed) void options.decision("unreviewed", true);
      const ratingAction = (["rating-0", "rating-1", "rating-2", "rating-3", "rating-4", "rating-5"] as const).find((action) => pressed === options.shortcuts[action]);
      if (ratingAction) void options.rating(Number(ratingAction.slice(-1)), true);
      if (options.view === "grid" && (pressed === options.shortcuts["zoom-out"] || pressed === options.shortcuts["zoom-in"])) {
        event.preventDefault();
        const next = Math.max(120, Math.min(340, options.gridSize + (pressed === options.shortcuts["zoom-in"] ? 20 : -20)));
        options.setGridSize(next);
        options.notify(`${shortcutLabel(pressed)}　圖庫縮放 ${next}px`);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
}
