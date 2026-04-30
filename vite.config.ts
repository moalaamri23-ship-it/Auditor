import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
    include: ['xlsx'],
  },
})