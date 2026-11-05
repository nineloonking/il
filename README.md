# 無量簿 Immeasurable Ledger

簡潔、離線可用的數字記錄 PWA。輸入數字、單位、文字與分類，資料保存在瀏覽器的
`localStorage`，可匯出／匯入 CSV。

## 使用

直接用瀏覽器開啟 `index.html` 即可；若透過 HTTP(S) 提供（例如本機伺服器或靜態
網站），會自動註冊 Service Worker 並支援離線使用。

- **輸入**：填數字 → 選單位 → 選分類 → 儲存。單位與分類可即時新增。
- **記錄**：依分類分組，可切換簡潔／詳細、搜尋、切換排序。
- **編輯**：點任一筆記錄開啟編輯面板，可修改或刪除（刪除後 6 秒內可復原）。
- **匯出／匯入**：CSV 使用 `Number, Unit, Text, Remarks, Category, Time, Location`
  欄位，編碼為 UTF-8（含 BOM，Excel 可直接開啟）。
- **清空**：會先匯出備份，再進行第二次確認。

## 修改使用說明

點擊畫面左上角的「無量簿」會開啟使用說明，內容放在 `help.js` 內的反引號之間。
`## ` 是小標題、`- ` 是清單項目、`> ` 是提示框，其餘文字會成為一般段落，
支援 `**粗體**`。改完存檔、重新載入即可看到。

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `index.html` | 頁面結構 |
| `styles.css` | 樣式（支援深色模式與手機版面） |
| `app.js` | 所有邏輯（無外部依賴） |
| `help.js` | 使用說明文字（點擊標題顯示，直接改這個檔） |
| `sw.js` | Service Worker，離線快取 |
| `manifest.json` | PWA 設定 |
| `icon.png` / `icon-512.png` | App 圖示（圓角、深色底） |
| `apple-touch-icon.png` | iOS 主畫面圖示（方形，由系統裁圓角） |
| `icon-old.png` | 舊版圖示備份 |
| `index-old.html` | 舊版，保留作為備份 |

## 資料

- 新資料存於 `localStorage` 的 `wuliangbu.v2`。
- 首次開啟時會自動讀取舊版資料（`entries`、`categories`、`units`、
  `lastCategory`、`lastUnit`）並轉換，舊資料不會被刪除，可隨時切回
  `index-old.html`。
- 換裝置請先「匯出 CSV」，再到新裝置「匯入」。

## 開發注意

- 不使用建置工具、不使用 ES Modules，因此 `file://` 直接開啟也能運作
  （Service Worker 僅在 HTTP(S) 下生效）。
- 修改檔案後若已註冊 Service Worker，請重新載入兩次或調整 `sw.js` 內的
  `CACHE_NAME` 版本號。
- 不要在 `<dialog>` 上做 `opacity` 的進場動畫（只用 `transform`）。實測在
  Chromium 會殘留錯誤的合成層，令底層頁面看起來「透出來」。
