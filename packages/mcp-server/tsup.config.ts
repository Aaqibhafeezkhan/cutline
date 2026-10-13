import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Internal workspace packages are TypeScript source; bundle them in.
  noExternal: [/^@cutline\//],
  // Optional, heavy (ONNX runtime): loaded lazily at runtime when transcription is used.
  external: ['@huggingface/transformers'],
  banner: { js: '#!/usr/bin/env node' },
});
