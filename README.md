# 台灣標案雷達｜GitHub Pages＋GitHub Actions 版

這個版本不需要 Netlify、Cloudflare 或本機伺服器。

- GitHub Pages：公開網站
- GitHub Actions：每 3 小時抓取標案資料
- JSON：`data/tenders.json`
- 歷史回補：每次預設回補 1 個月，直到 2024 年
- 手動同步：Actions → 同步標案資料 → Run workflow

完整操作請看 `GITHUB_PAGES_SETUP.md`。

> 注意：GitHub Pages 是靜態網站。網頁每 10 秒檢查資料，但只有 Actions 完成、提交 JSON 並由 Pages 重新發布後，才會看到新資料；無法像即時資料庫一樣逐筆出現。
