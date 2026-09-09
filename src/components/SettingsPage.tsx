import type { Dispatch, SetStateAction } from "react";
import { shortcutGroups, shortcutLabel, themeLabels, type ShortcutAction, type ShortcutMap, type Theme } from "../lib/photos";

type SettingsPageProps = {
  root: string;
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
  burstGapMs: number;
  setBurstGapMs: Dispatch<SetStateAction<number>>;
  previewProfile: "speed" | "balanced" | "quality";
  setPreviewProfile: Dispatch<SetStateAction<"speed" | "balanced" | "quality">>;
  preloadCount: number;
  setPreloadCount: Dispatch<SetStateAction<number>>;
  rawCacheOnly: boolean;
  setRawCacheOnly: Dispatch<SetStateAction<boolean>>;
  cacheStatus: { bytes: number; files: number; limitMb: number; failures: { relativePath: string; error: string }[] } | null;
  syncStatus: { available: boolean; pending: number; issues: { relativePath: string; attempts: number; lastError?: string }[] } | null;
  reviewSession: { reviewedCount: number; totalCount: number; pausedAt?: number } | null;
  onUpdateCacheLimit: (limitMb: number) => void;
  onClearDerivedCache: () => void;
  onRetrySync: (repair?: boolean) => void;
  onUpdateSession: (paused?: boolean) => void;
  onSnapshot: () => void;
  onRunAssistance: () => void;
  onExport: (format: "csv" | "json" | "xmp") => void;
};

const mb = (value: number) => value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} GB` : `${Math.round(value / 1024)} MB`;

export function SettingsPage({ root, theme, setTheme, gridSize, setGridSize, autoAdvance, setAutoAdvance, shortcuts, editingShortcut, shortcutStatus, onClose, onStartShortcutEdit, onRestoreShortcuts, burstGapMs, setBurstGapMs, previewProfile, setPreviewProfile, preloadCount, setPreloadCount, rawCacheOnly, setRawCacheOnly, cacheStatus, syncStatus, reviewSession, onUpdateCacheLimit, onClearDerivedCache, onRetrySync, onUpdateSession, onSnapshot, onRunAssistance, onExport }: SettingsPageProps) {
  return <section className="settings-page" aria-labelledby="settings-title"><div className="settings-card">
    <div><h1 id="settings-title">設定</h1><button type="button" className="icon-button" onClick={onClose} aria-label="完成" title="完成">×</button></div>
    <section><h2>外觀</h2><label>主題<select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>{(Object.keys(themeLabels) as Theme[]).map((value) => <option key={value} value={value}>{themeLabels[value]}</option>)}</select></label><label>縮圖 <output>{gridSize}px</output><input type="range" min="120" max="340" step="10" value={gridSize} onChange={(event) => setGridSize(Number(event.target.value))} /></label></section>
    <section><label className="toggle"><input type="checkbox" checked={autoAdvance} onChange={(event) => setAutoAdvance(event.target.checked)} /><span />旗標後自動下一張</label></section>
    {root && <>
      <section><div className="settings-section-heading"><h2>工作階段</h2><div><button type="button" onClick={() => onUpdateSession(false)}>儲存進度</button><button type="button" onClick={() => onUpdateSession(true)}>暫停</button></div></div><p className="settings-note">{reviewSession ? `${reviewSession.reviewedCount} / ${reviewSession.totalCount} 已審` : "尚未建立工作階段"}</p><button type="button" onClick={onSnapshot}>建立決定快照</button></section>
      <section><h2>連拍與預覽</h2><label>連拍間隔 <output>{(burstGapMs / 1000).toFixed(1)} 秒</output><input type="range" min="500" max="5000" step="250" value={burstGapMs} onChange={(event) => setBurstGapMs(Number(event.target.value))} /></label><label>預覽模式<select value={previewProfile} onChange={(event) => setPreviewProfile(event.target.value as "speed" | "balanced" | "quality")}><option value="speed">速度優先</option><option value="balanced">平衡</option><option value="quality">品質優先</option></select></label><label>預先載入<select value={preloadCount} onChange={(event) => setPreloadCount(Number(event.target.value))}>{[0, 6, 12, 24, 48].map((value) => <option key={value} value={value}>{value} 張</option>)}</select></label><label className="toggle"><input type="checkbox" checked={rawCacheOnly} onChange={(event) => setRawCacheOnly(event.target.checked)} /><span />RAW 只用既有預覽</label></section>
      <section><div className="settings-section-heading"><h2>本機技術提示</h2><button type="button" onClick={onRunAssistance}>分析</button></div><p className="settings-note">模糊、曝光與相似畫面只供人工判斷；完全離線，不會自動淘汰。人臉／閉眼辨識未啟用。</p></section>
      <section><div className="settings-section-heading"><h2>同步</h2><div>{syncStatus?.available ? <><button type="button" onClick={() => onRetrySync(false)}>重試</button><button type="button" onClick={() => onRetrySync(true)}>安全修復</button></> : <span className="settings-note">此平台未啟用原生標籤</span>}</div></div><p className="settings-note">{syncStatus?.available ? syncStatus.pending ? `${syncStatus.pending} 項等待 Finder 同步` : "Finder 同步正常" : "Windows 原生中繼資料保持停用，直到完成驗證。"}</p>{syncStatus?.issues.slice(0, 3).map((issue) => <p className="issue" key={issue.relativePath}>{issue.relativePath} · {issue.lastError ?? `已重試 ${issue.attempts} 次`}</p>)}</section>
      <section><div className="settings-section-heading"><h2>快取</h2><button type="button" onClick={onClearDerivedCache}>清除衍生快取</button></div><p className="settings-note">{cacheStatus ? `${mb(cacheStatus.bytes)} · ${cacheStatus.files} 個預覽 · ${cacheStatus.failures.length} 個失敗` : "讀取快取狀態中…"}</p><label>上限<select value={cacheStatus?.limitMb ?? 2048} onChange={(event) => onUpdateCacheLimit(Number(event.target.value))}>{[512, 1024, 2048, 4096, 8192].map((value) => <option key={value} value={value}>{value >= 1024 ? `${value / 1024} GB` : `${value} MB`}</option>)}</select></label>{cacheStatus?.failures.slice(0, 3).map((failure) => <p className="issue" key={failure.relativePath}>{failure.relativePath} · {failure.error}</p>)}</section>
      <section><div className="settings-section-heading"><h2>非破壞式匯出</h2><div><button type="button" onClick={() => onExport("csv")}>CSV</button><button type="button" onClick={() => onExport("json")}>JSON</button><button type="button" onClick={() => onExport("xmp")}>XMP</button></div></div><p className="settings-note">CSV／JSON 為決定清單；XMP 會輸出至另選位置的「Cadris XMP」，不會修改原始照片。</p></section>
    </>}
    <section className="shortcut-settings"><div className="settings-section-heading"><h2>快捷鍵</h2><button type="button" onClick={onRestoreShortcuts}>還原</button></div>{shortcutGroups.map((group) => <div className="shortcut-group" key={group.title}><h3>{group.title}</h3><div className="shortcut-list">{group.actions.map((item) => <div className="shortcut-row" key={item.action}><span>{item.label}</span><button type="button" className={editingShortcut === item.action ? "shortcut-capture active" : "shortcut-capture"} aria-pressed={editingShortcut === item.action} onClick={() => onStartShortcutEdit(item.action)}>{editingShortcut === item.action ? "按鍵…" : <kbd>{shortcutLabel(shortcuts[item.action])}</kbd>}</button></div>)}</div></div>)}{shortcutStatus && <p className="shortcut-status" role="status" aria-live="polite">{shortcutStatus}</p>}</section>
  </div></section>;
}
