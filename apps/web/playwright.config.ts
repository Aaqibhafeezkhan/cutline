import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Isolated ports and data so the smoke test never touches a running dev setup.
const SERVER_PORT = 4310;
const WEB_PORT = 5174;
const dataDir = mkdtempSync(join(tmpdir(), 'cutline-e2e-'));
const fixtures = resolve(import.meta.dirname, '../../fixtures/media');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=msedge|chrome uses an installed browser (with proprietary codecs).
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined },
    },
  ],
  webServer: [
    {
      command: 'node --import tsx src/cli.ts',
      cwd: resolve(import.meta.dirname, '../../packages/mcp-server'),
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        CUTLINE_PORT: String(SERVER_PORT),
        CUTLINE_DATA_DIR: dataDir,
        CUTLINE_MEDIA_ROOTS: fixtures,
        CUTLINE_PUBLIC_URL: `http://localhost:${WEB_PORT}`,
      },
      stdout: 'pipe',
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { CUTLINE_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});

export { SERVER_PORT, fixtures };
