import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev runs same-origin like production (nginx): the browser only talks to :5173, and these paths
// are proxied to the backend. That keeps the httpOnly refresh cookie and /ws working unchanged.
const backend = globalThis.process?.env.NULLIFY_BACKEND ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true },
  server: {
    proxy: {
      '/api': backend,
      '/health': backend,
      '/ws': { target: backend, ws: true },
    },
  },
})
