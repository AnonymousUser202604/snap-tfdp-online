import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // User/org site snap-tfdp.github.io is served at domain root — keep default base '/'.
  // If you ever use Project Pages (e.g. snap-tfdp.github.io/repo-name/), set base: '/repo-name/'.
  base: '/snap-tfdp-online/',
  plugins: [vue()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
