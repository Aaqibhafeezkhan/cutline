import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const serverUrl = process.env.CUTLINE_SERVER_URL ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': serverUrl,
      '/mcp': serverUrl,
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
