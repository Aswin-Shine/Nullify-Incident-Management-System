import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev runs same-origin like production (nginx): the browser only talks to :5173, and these paths
// are proxied to the backend. That keeps the httpOnly refresh cookie and /ws working unchanged.
const backend = globalThis.process?.env.NULLIFY_BACKEND ?? 'http://127.0.0.1:8000'  // the dev backend binds IPv4 loopback only (start.sh)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.js'] },
  server: {
    proxy: {
      '/api': backend,
      '/health': backend,
      '/ws': { target: backend, ws: true },
    },
  },
})
