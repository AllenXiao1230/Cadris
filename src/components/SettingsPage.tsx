import type { Dispatch, SetStateAction } from "react";
import { shortcutGroups, shortcutLabel, themeLabels, type ShortcutAction, type ShortcutMap, type Theme } from "../lib/photos";

type SettingsPageProps = {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  gridSize: number;
  setGridSize: Dispatch<SetStateAction<number>>;
  autoAdvance: boolean;
  setAutoAdvance: Dispatch<SetStateAction<boolean>>;
  shortcuts: ShortcutMap;
  editingShortcut: ShortcutAction | null;
  shortcutStatus: string;
  onClose: () => void;
  onStartShortcutEdit: (action: ShortcutAction) => void;
  onRestoreShortcuts: () => void;
};

export function SettingsPage({ theme, setTheme, gridSize, setGridSize, autoAdvance, setAutoAdvance, shortcuts, editingShortcut, shortcutStatus, onClose, onStartShortcutEdit, onRestoreShortcuts }: SettingsPageProps) {
  return <section className="settings-page" aria-labelledby="settings-title"><div className="settings-card">
    <div><h1 id="settings-title">設定</h1><button type="button" className="icon-button" onClick={onClose} aria-label="完成" title="完成">×</button></div>
    <section><h2>外觀</h2><label>主題<select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>{(Object.keys(themeLabels) as Theme[]).map((value) => <option key={value} value={value}>{themeLabels[value]}</option>)}</select></label><label>縮圖 <output>{gridSize}px</output><input type="range" min="120" max="340" step="10" value={gridSize} onChange={(event) => setGridSize(Number(event.target.value))} /></label></section>
    <section><label className="toggle"><input type="checkbox" checked={autoAdvance} onChange={(event) => setAutoAdvance(event.target.checked)} /><span />旗標後自動下一張</label></section>
    <section className="shortcut-settings"><div className="settings-section-heading"><h2>快捷鍵</h2><button type="button" onClick={onRestoreShortcuts}>還原</button></div>{shortcutGroups.map((group) => <div className="shortcut-group" key={group.title}><h3>{group.title}</h3><div className="shortcut-list">{group.actions.map((item) => <div className="shortcut-row" key={item.action}><span>{item.label}</span><button type="button" className={editingShortcut === item.action ? "shortcut-capture active" : "shortcut-capture"} aria-pressed={editingShortcut === item.action} onClick={() => onStartShortcutEdit(item.action)}>{editingShortcut === item.action ? "按鍵…" : <kbd>{shortcutLabel(shortcuts[item.action])}</kbd>}</button></div>)}</div></div>)}{shortcutStatus && <p className="shortcut-status" role="status" aria-live="polite">{shortcutStatus}</p>}</section>
  </div></section>;
}
