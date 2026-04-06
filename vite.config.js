import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => ({
  // Use root base in dev for local asset paths; use repo subpath in production build for GitHub Pages.
  base: command === 'serve' ? '/' : '/snap-tfdp-online/',
  plugins: [vue()],
}))
