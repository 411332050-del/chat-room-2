import { defineConfig } from 'vite'

// GitHub Pages 的網址帶有儲存庫名稱，所以部署時由 workflow 傳入 VITE_BASE
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
})
