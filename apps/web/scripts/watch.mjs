// Dev helper: keep a page open and take periodic screenshots (e.g. while an agent edits).
//   node scripts/watch.mjs <url> <outDir> [count=8] [intervalMs=3000]
import { chromium } from '@playwright/test';
import { join } from 'node:path';

const [url, outDir, count = '8', interval = '3000'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
for (let i = 0; i < Number(count); i++) {
  await page.waitForTimeout(Number(interval));
  await page.screenshot({ path: join(outDir, `watch-${String(i).padStart(2, '0')}.png`) });
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
