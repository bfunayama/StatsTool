import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Forward any request starting with /api to the FastAPI backend,
    // so the frontend can call the backend without CORS issues in dev.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
