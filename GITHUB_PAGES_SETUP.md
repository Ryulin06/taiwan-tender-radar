# GitHub Pages＋GitHub Actions 完整設定步驟

## 1. 建議先清空舊 Netlify 檔案

在 Repository 保留或覆蓋均可，但新的最外層必須直接看到：

- `index.html`
- `data/`
- `scripts/`
- `.github/workflows/`
- `package.json`
- `.nojekyll`

舊的 `netlify/`、`public/`、`netlify.toml` 不再使用，可刪除避免混淆。

## 2. 上傳本專案

解壓縮 ZIP，打開資料夾後，全選裡面的內容，拖到 GitHub Repository 的 Upload files 頁面。不要多包一層資料夾。

## 3. 開啟 GitHub Pages

Repository → Settings → Pages：

- Source：Deploy from a branch
- Branch：main
- Folder：/ (root)
- Save

網站網址通常是：

`https://你的帳號.github.io/taiwan-tender-radar/`

## 4. 開啟 Actions 寫入權限

Repository → Settings → Actions → General → Workflow permissions：

- 選 `Read and write permissions`
- Save

## 5. 第一次手動同步

Repository → Actions → 左側「同步標案資料」→ Run workflow：

- Branch 選 main
- `backfill_months` 建議先填 1
- 再按綠色 Run workflow

完成後 Repository 會新增一筆「自動更新標案資料」Commit。

## 6. 自動排程

工作流程已設定每 3 小時執行一次：

`17 */3 * * *`

GitHub Actions 排程採 UTC，且可能因平台負載稍微延遲。

## 7. 歷史資料

- 起始年份固定為 2024
- 每次 Action 預設回補 1 個月
- 手動執行時可輸入 0～3 個月
- 已抓到的舊資料會保留

## 8. 常見問題

### Actions 找不到 Run workflow

確認 `.github/workflows/sync-tenders.yml` 已存在於 main branch。

### Action 無法 push

確認 Workflow permissions 已設為 Read and write permissions。

### 網站是空白資料

先執行一次 Actions，並等待 Action 成功及 Pages 重新發布。

### 公司電腦不用安裝任何東西嗎？

不用。所有操作都可在 GitHub 網頁完成。
