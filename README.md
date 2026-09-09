# Cadris

> Find the frames worth keeping.

Cadris 是一個以鍵盤為中心的 macOS／Windows 照片篩圖工具。它參考 Lightroom CC 的旗標與星等操作，讓你在圖庫或單張檢視中快速選出值得留下的畫面。

目前的 MVP 以本機、離線使用為原則：不匯入、不移動、不刪除原始照片。

## 現有功能

- 選擇照片資料夾並以背景工作池遞迴掃描 JPEG、HEIC、PNG、TIFF、WebP 與常見 RAW 副檔名；隱藏資料夾與 `.cadris` 狀態資料會安全略過。
- 圖庫檢視、單張檢視、檔名搜尋、排序、旗標篩選與星等；正方形格點會完整顯示照片比例，並將檔名與格式放在左／右上方的小標籤；另可切換依比例自適應的照片格點。
- 單張細節檢視：可用滑桿、按鈕或滾輪調整 100–400% 縮放，放大後可直接拖曳平移，並可隨時置中。
- 多張比較：以 `C` 將最多 4 張照片放入比較清單，在同步縮放／平移的 2–4 格檢視中檢查細節。
- 同檔名 RAW 與 JPEG／HEIC 會以一個配對項目呈現，旗標與星等會同步套用；連拍會自動標示，並可一鍵加入比較。
- JPEG、PNG、TIFF 與 WebP 使用 SIMD 縮放建立本機縮圖快取；macOS 的 HEIC 與常見 RAW（含 RAF、ARW、CR3、DNG、NEF）會改用系統影像預覽生成快取。單張與比較檢視同樣使用這個安全的預覽來源。
- 圖庫縮放：可用頂端滑桿、設定頁面，或 `-`／`=` 快速調整縮圖大小。
- 液態玻璃深色介面：以藍色作為 UI 強調色，保留 Finder 綠／紅標籤的原生同步語意。
- 設定頁面：集中管理圖庫縮放、「設定旗標後自動前往下一張」，以及可持久保存的快捷鍵配置。
- 常駐篩選列：隨時可見 `Z`／`X`／`U` 旗標與 `0`–`5` 星等，並反映目前照片狀態。
- 每次以快捷鍵操作時，會顯示提示；最近一次旗標或星等可用 `⌘Z`／`Ctrl+Z` 回復。
- 圖庫使用可視範圍渲染，長圖庫不會一次建立所有縮圖卡片。
- 圖庫卡片支援單張、`Shift` 範圍、`Command`／`Control` 加選，以及 `Command`／`Control` + `Shift` 延伸選取；選取區使用可存取的多選清單語意與鍵盤焦點循環。
- 底部顯示已審／待審進度；完成一輪後可直接檢查淘汰或檢視保留照片。
- EXIF 資訊：拍攝時間、相機、鏡頭、光圈／快門／ISO；缺失資料會顯示為 `—`。
- 在單張檢視使用左右鍵，依目前篩選結果切換上一張／下一張。
- 將篩選決定安全保存於所選圖庫內的 `.cadris/manifest.sqlite`；資料庫使用 WAL、版本遷移與 FTS5 索引，可搜尋檔名、相機與鏡頭。
- 外部建立、刪除、重新命名或改寫照片時，會顯示「重新整理」提示；Cadris 不會在選片中途自動重掃。
- macOS：保留、淘汰與取消旗標會同步 Finder 標籤，且保留使用者既有的其他標籤。
- 介面主題可在設定中切換「午夜藍／石墨／暖灰」；三套主題使用同一組語義色彩 token，主要文字與控制項已加入 4.5:1 對比檢查。

## 快捷鍵

| 按鍵 | 行為 |
|---|---|
| `Z` | 保留（綠色旗標） |
| `X` | 淘汰（紅色旗標） |
| `U` | 清除旗標，回到未審 |
| `0`–`5` | 清除／設定星等 |
| `←` / `→` | 上一張／下一張 |
| `G` | 切換至圖庫檢視 |
| `C` | 將目前照片加入／移出比較清單 |
| `Space`（圖庫） | 開啟目前照片的單張檢視 |
| `Space`（單張） | 切換整張／200% 細節縮放 |
| `-` / `=`（圖庫） | 縮小／放大縮圖 |
| `⌘Z`／`Ctrl+Z` | 復原最近一次旗標或星等（固定） |

除復原外，所有列出的快捷鍵均可在「設定 → 快捷鍵」中改為任一未使用的單一按鍵；可隨時還原 Lightroom CC 預設值，設定會保存在這台電腦上。

## Finder 標籤同步（macOS）

| Cadris 決定 | Finder 標籤 |
|---|---|
| 保留 | `Cadris: Keep`（綠色） |
| 淘汰 | `Cadris: Reject`（紅色） |
| 未審 | 移除上述 Cadris 標籤 |

Cadris 僅管理 `Cadris:` 前綴的兩個標籤；婚禮、客戶、地點或其他既有 Finder 標籤都會原樣保留。

Windows 目前保存相同的 portable SQLite 決定資料，但尚未寫入 Explorer keywords。Windows 原生標籤功能須經實機驗證後才會開啟，避免意外改寫影像 metadata。

## 開發

### 需求

- Node.js 26 或更新版本
- pnpm 11 或更新版本
- Rust stable toolchain
- macOS 開發需安裝 Xcode Command Line Tools
- Windows 開發需安裝 Visual Studio C++ Build Tools 與 Windows SDK

### 安裝與啟動

```sh
pnpm install
pnpm tauri dev
```

### 驗證

```sh
pnpm test:contrast
pnpm build
pnpm test
pnpm test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm audit:dependencies
```

GitHub Actions 會在每次 push 與 pull request 執行前端測試、Playwright 流程、Rust fmt／Clippy／測試、相依套件稽核，以及 macOS／Windows 原生建置。Windows 的 Explorer 關鍵字同步仍保持關閉，必須經 Windows 實機與影像格式測試後才能開啟。

## 專案結構

```text
src/                 React 使用介面
src/components/      圖庫、單張、比較、設定與共用影像元件
src/hooks/            鍵盤流程與互動 hook
src/lib/              照片模型、配對、連拍與選取規則
src/cache/            預覽來源快取與請求合併
src-tauri/src/       Rust 掃描、SQLite、EXIF 與平台同步邏輯
src-tauri/icons/     桌面應用程式圖示
.github/workflows/   CI 品質與雙平台原生建置
```

## 已知限制與下一步

- macOS 的 RAW／HEIC 預覽由系統 ImageIO 提供；相機格式支援仍以實機預覽結果為準。Windows 目前會安全回退到 WebView 可顯示的格式。
- EXIF 排序與進階篩選仍在開發中；目前已提供拍攝時間、相機、鏡頭、曝光與星等資訊。
- Windows Explorer `System.Keywords`、外部修改的進階衝突處理與跨裝置 manifest 合併尚未完成。
- Cadris 不會提供「直接刪除原始照片」作為 MVP 功能。

## 資料與隱私

照片不會上傳到任何服務。Cadris 只會讀取使用者選擇的圖庫資料夾，並在其中建立 `.cadris/manifest.sqlite` 來保存決定與星等。macOS 啟用旗標時，Cadris 會寫入對應的 Finder 標籤。

縮圖快取會儲存在同一個 `.cadris/thumbnails/` 資料夾；它只包含衍生的預覽影像，可隨時安全刪除，Cadris 會在需要時重新建立。

## 打包 macOS 原生執行檔

```sh
pnpm tauri build --bundles app
```

完成後的 `.app` 位於 `src-tauri/target/release/bundle/macos/Cadris.app`。本專案目前只產生原生 `.app`，不產生 `.dmg`；未簽署版本首次在其他 Mac 開啟時，macOS 可能要求使用者在系統設定中明確允許。
