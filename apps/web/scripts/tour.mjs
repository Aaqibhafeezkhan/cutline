// Dev helper: click through the editor and screenshot each state.
//   node scripts/tour.mjs <editorUrl> <outDir>
import { chromium } from '@playwright/test';
import { join } from 'node:path';

const [url, outDir] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: join(outDir, `tour-${name}.png`) });

await page.goto(url);
await page.waitForSelector('[data-clip-id]');
await page.waitForTimeout(1500);

// Select the first video clip
await page.locator('[data-clip-id]').filter({ hasText: 'talk.mp4' }).first().click();
await page.waitForTimeout(500);
await shot('1-selected');

await page.getByRole('tab', { name: 'Captions' }).click();
await page.waitForTimeout(300);
await shot('2-captions');

await page.getByRole('tab', { name: 'Activity' }).click();
await page.waitForTimeout(300);
await shot('3-activity');

// Seek into a caption and play briefly
await page.keyboard.press('Escape');
await page.locator('[aria-label="Playhead position"]').click({ position: { x: 300, y: 10 } });
await page.waitForTimeout(800);
await shot('4-seek');
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const time = await page.locator('section[aria-label="Preview"] span.font-mono').textContent();
await shot('5-played');

// Split with the keyboard and undo it
const before = await page.locator('[data-clip-id]').count();
await page.keyboard.press('s');
await page.waitForTimeout(800);
const afterSplit = await page.locator('[data-clip-id]').count();
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
const afterUndo = await page.locator('[data-clip-id]').count();

console.log(JSON.stringify({ time, before, afterSplit, afterUndo }));
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
