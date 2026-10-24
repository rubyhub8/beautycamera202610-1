# 美顏相機

純網頁版美顏相機，所有處理都在瀏覽器本機完成，照片不會上傳。

## 功能（v1）
- 即時預覽：磨皮、美白、紅潤（可用滑桿調整強度）
- 6 種濾鏡：原圖、底片、日系、冷調、暖調、黑白
- 前後鏡頭切換、倒數計時（3／5／10 秒）
- 拍照後預覽、下載、分享

## 部署到 GitHub Pages
1. 在 GitHub 建立新儲存庫（例如 `beauty-camera`），設為 Public
2. 把 `index.html`、`style.css`、`app.js`、`README.md` 上傳到儲存庫根目錄
3. 進入 Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾 `/ (root)`，按 Save
4. 約一分鐘後，網址會是 `https://你的帳號.github.io/beauty-camera/`

> 相機功能需要 https，GitHub Pages 預設就是 https，可以直接使用。

## 下一步計畫
- 接入 MediaPipe 人臉關鍵點：瘦臉、大眼、亮眼、美牙
- PWA：安裝到主畫面、離線使用
