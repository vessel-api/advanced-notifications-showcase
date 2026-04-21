import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'

export async function createViteMiddleware() {
  const vite = await createViteServer({
    root: 'client',
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    appType: 'spa'
  })
  return vite.middlewares
}
