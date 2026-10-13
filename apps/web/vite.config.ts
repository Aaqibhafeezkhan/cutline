import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const serverUrl = process.env.CUTLINE_SERVER_URL ?? 'http://127.0.0.1:4100';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../../fixtures/media', import.meta.url)).replace(
  /\\/g,
  '/',
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    // Only used by the dev-only engine playground (dev/engine.html).
    __FIXTURES_DIR__: JSON.stringify(fixturesDir),
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': serverUrl,
      '/mcp': serverUrl,
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
