// Dev helper: screenshot a page in headless Chromium/Edge and print console errors.
//   node scripts/snap.mjs <url> <out.png> [waitMs] [channel]
import { chromium } from '@playwright/test';

const [url, out, wait = '2500', channel = 'msedge'] = process.argv.slice(2);
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
