import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages 等子路径部署：PAGES_BASE=./ npm run build
// 未设置时保持根路径，开发与本地预览行为不变。
const base = process.env.PAGES_BASE || '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
})
