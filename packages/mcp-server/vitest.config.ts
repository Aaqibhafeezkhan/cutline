import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Pick up FFMPEG_PATH etc. from the repository's .env (if any) so media tests run locally.
const dotenv = resolve(import.meta.dirname, '../../.env');
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

export default defineConfig({
  test: { testTimeout: 30_000 },
});
