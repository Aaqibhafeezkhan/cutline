// Captures the README screenshot: open a project, wait for an agent to add captions, then shoot.
//   node scripts/hero.mjs <editorUrl> <out.png>   (run the demo agent's edit step meanwhile)
import { chromium } from '@playwright/test';

const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL ?? 'msedge',
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 960 },
  deviceScaleFactor: 1,
});
await page.goto(url);
await page.waitForSelector('[data-clip-id]');
await page.getByRole('tab', { name: 'Activity' }).click();
// Captions added by the agent show up highlighted.
await page.waitForSelector('[data-clip-id].agent-highlight >> text=/recording/i', {
  timeout: 180_000,
});
await page.waitForTimeout(400);
const ruler = page.locator('[aria-label="Playhead position"]');
await ruler.click({ position: { x: 5.2 * 60, y: 10 } });
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}`);
