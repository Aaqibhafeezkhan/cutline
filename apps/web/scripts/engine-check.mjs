// Ad-hoc engine verification: screenshot the preview and run a browser export.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/dev/engine.html');
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, {
  timeout: 30000,
});
await page.locator('#preview').screenshot({ path: join(out, 'frame-1.5.png') });
// crossfade region + caption second cue
await page.evaluate(async () => {
  await window.cutlineDemo.player.renderFrame(3.2);
});
await page.waitForTimeout(300);
await page.locator('#preview').screenshot({ path: join(out, 'frame-3.2.png') });

const t0 = Date.now();
const result = await page.evaluate(async () => {
  const r = await window.cutlineDemo.exportVideo({ width: 640 });
  const buf = new Uint8Array(await r.blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return {
    b64: btoa(bin),
    videoCodec: r.videoCodec,
    audioCodec: r.audioCodec,
    width: r.width,
    height: r.height,
    duration: r.duration,
  };
});
writeFileSync(join(out, 'export.mp4'), Buffer.from(result.b64, 'base64'));
console.log(JSON.stringify({ ...result, b64: undefined, ms: Date.now() - t0 }));
console.log(logs.filter((l) => !l.includes('[vite]') && !l.includes('DevTools')).join('\n'));
await browser.close();
