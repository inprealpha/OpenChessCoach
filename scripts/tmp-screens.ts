// TEMPORARY (removed before the final commit): screenshots every board screen in a real browser
// engine at desktop and iPhone sizes, and reports any page wider or taller than the screen.
// Usage: node scripts/tmp-screens.ts <chromium|webkit> <out dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, type Page } from '@playwright/test';
import { startVerifyInstance } from '../packages/backend/src/verify/instance.ts';

const engine = process.argv[2] === 'webkit' ? webkit : chromium;
const out = process.argv[3] ?? 'screens';
mkdirSync(out, { recursive: true });

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// Safari's visible area with its toolbars: iPhone 16 Pro (402 wide) and 16 Pro Max (440 wide).
const sizes = [
  { name: 'desktop', width: 1280, height: 800, mobile: false },
  { name: 'iphone-402', width: 402, height: 714, mobile: true },
  { name: 'iphone-440', width: 440, height: 790, mobile: true },
];
const screens: { name: string; route: string; then?: (page: Page) => Promise<void> }[] = [
  { name: 'menu', route: '#/' },
  { name: 'board', route: '#/board' },
  {
    name: 'review',
    route: '#/review/1',
    then: async (page) => {
      const start = page.getByRole('button', { name: 'Start the Review' });
      if (await start.isVisible().catch(() => false)) {
        await start.click();
        await page.getByRole('button', { name: 'Start the Review' }).waitFor({ state: 'detached', timeout: 120_000 });
        await page.waitForTimeout(4000);
      }
    },
  },
  { name: 'engine-game', route: '#/engine-game' },
  { name: 'lesson', route: '#/lesson/italian-game' },
  { name: 'puzzles', route: '#/puzzles/italian-game' },
];

const instance = await startVerifyInstance({ seed: 'default', chunkDelayMs: 0 });
const browser = await engine.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const report: Record<string, unknown>[] = [];
try {
  for (const size of sizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 2,
      ...(size.mobile ? { isMobile: true, hasTouch: true, userAgent: IPHONE_UA } : {}),
    });
    const page = await context.newPage();
    await page.goto(`${instance.url}/#pair=${instance.code}`);
    await page.getByRole('status', { name: 'Connection' }).filter({ hasText: /connected/i }).waitFor({ timeout: 20_000 });
    for (const screen of screens) {
      await page.goto(`${instance.url}/${screen.route}`);
      await page.waitForTimeout(2500);
      if (screen.then) await screen.then(page);
      const box = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        // On a phone the layout viewport grows to fit what overflows, so the screen is the visual viewport.
        innerWidth: Math.round(window.visualViewport?.width ?? window.innerWidth),
        innerHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
        // Elements cut off at the screen's sides, which overflow: hidden hides from scrollWidth.
        offscreen: [...document.querySelectorAll<HTMLElement>('button, a, input, [role]')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > (window.visualViewport?.width ?? window.innerWidth) + 1 || r.left < -1);
          })
          .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName),
      }));
      const file = `${screen.name}-${size.name}.png`;
      await page.screenshot({ path: join(out, file) });
      await page.screenshot({ path: join(out, file.replace('.png', '.jpg')), type: 'jpeg', quality: 60, scale: 'css' });
      report.push({ engine: process.argv[2], screen: screen.name, size: size.name, ...box, overflowX: box.scrollWidth > box.innerWidth || box.offscreen.length > 0, overflowY: box.scrollHeight > box.innerHeight });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await instance.stop();
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.filter((r) => r.overflowX || r.overflowY), null, 1));
