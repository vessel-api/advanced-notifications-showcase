import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
  appType: 'spa',
  build: { outDir: '../dist', emptyOutDir: true }
})
