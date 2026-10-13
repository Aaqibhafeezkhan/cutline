// Dev helper: find out what blocks the main thread (pauses via CDP and prints the stack).
import { chromium } from '@playwright/test';

const [url] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(4000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Debugger.enable');
const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
await cdp.send('Debugger.pause');
const event = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 5000))]);
if (event) {
  for (const f of event.callFrames.slice(0, 25)) {
    console.log(
      `${f.functionName || '(anon)'}  ${f.url.split('/').slice(-2).join('/')}:${f.location.lineNumber + 1}`,
    );
  }
} else console.log('could not pause (thread idle?)');
console.log('--- console');
console.log(logs.slice(-30).join('\n'));
await browser.close();
