# 匿名聊天室 2

一個不用註冊登入的匿名聊天室，所有人在同一個聊天室裡。前端用原生 TypeScript 加 Vite，部署在 GitHub Pages；後端用 Supabase（資料庫、即時推送、在線人數、匿名登入）。

## 進入方式

1. 打開網址，第一個看到的是進入畫面。
2. 在「代號」輸入框輸入代號（去頭尾空白後 1～12 字，不合格時按鈕停用並顯示原因）。
3. 按「進入聊天室」（或在輸入框按 Enter）。

進入後你的名稱是「代號＋#＋3 碼編號」，例如「小明#371」，顯示在頂部的「你是：」。編號由資料庫產生，同一個匿名身分固定不變，無法自己指定。

## 功能與在畫面上怎麼看到

| 功能 | 在畫面上怎麼看到 |
|---|---|
| 即時聊天 | 一邊送出訊息，另一個視窗不用重新整理就出現。 |
| 在線人數 | 頂部「N 人在線」，有人進出會更新；按「離開」會馬上減少。 |
| 歷史訊息 | 進入時看到最近 50 則；按最上方「載入更早的訊息」載入更多，載完顯示「已經是最早的訊息」，失敗可再按。 |
| 傳送狀態 | 自己的訊息顯示「傳送中…」→「已送出」；失敗顯示「傳送失敗」與「重試」。 |
| 發言頻率限制（資料庫強制） | 10 秒內送超過 5 則，或兩則間隔不到 0.5 秒，顯示「發言太快了，請稍等幾秒」。 |
| 內容清理（資料庫強制） | 隱形字元會被移除，連續空行折成一個，頭尾空白去掉。 |
| 純文字顯示 | 貼上 `<b>粗體</b>` 會原樣顯示成文字，不會變粗體或執行。 |
| 收到的訊息先驗證格式 | 格式不合（id 不是 UUID、名稱不是 1–20 字、內容不是 1–500 字、時間無法解析）的訊息不顯示，只在開發者工具 Console 留一行警告。 |
| 斷線重連 | 斷線顯示「重新連線中…」，恢復後補齊錯過的訊息；超過 60 秒回到進入畫面。 |

## 本機啟動

```
npm install
npm run dev
```

複製 `.env.example` 成 `.env.local`，填入 Project URL 與 publishable key（可公開金鑰）。絕不放 secret key 或資料庫密碼；`.env.local` 不會被 commit。

## 資料庫

不使用 Supabase CLI。到 Supabase 後台：

1. Authentication → Sign In / Providers，打開 **Allow anonymous sign-ins**。
2. SQL Editor → New query，把 `supabase/schema.sql` 的**內容**整份貼上，按 Run。

## 部署

推到 `main` 後，GitHub Actions（`.github/workflows/pages.yml`）自動打包並上架到 GitHub Pages。Project URL 與 publishable key 放在儲存庫 Settings → Secrets and variables → Actions（`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`）。

更多設計說明見 `docs/architecture.md`。
