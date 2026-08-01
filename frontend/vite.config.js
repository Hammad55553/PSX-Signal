import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Build output goes to repo root /dist so Vercel can find it directly
    outDir: '../dist',
    emptyOutDir: true,
  }
})
