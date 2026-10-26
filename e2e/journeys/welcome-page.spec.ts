// The welcome page (site/index.html), which most people first open from a link on their phone. Its
// steps set up the computer that runs OpenChessCoach, so on a phone or tablet the page must not
// claim to have detected that computer's system.
import { type BrowserContextOptions, devices, expect, test } from '@playwright/test';

const SITE = new URL('../../site/index.html', import.meta.url).href;
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

interface Visitor {
  name: string;
  device: BrowserContextOptions;
  platform: string;
  /** What navigator.userAgentData says, where the browser has it (Chromium only). */
  userAgentData?: { platform: string; mobile: boolean };
}

const phone = (name: string): BrowserContextOptions => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name]!;
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
};

const phones: Visitor[] = [
  { name: 'an iPhone', device: phone('iPhone 13'), platform: 'iPhone' },
  // iPadOS Safari calls itself a Mac; only the touch screen gives it away.
  { name: 'an iPad', device: { ...phone('iPad Pro 11'), userAgent: MAC_SAFARI }, platform: 'MacIntel' },
  { name: 'Android in Chrome', device: phone('Pixel 7'), platform: 'Linux armv81', userAgentData: { platform: 'Android', mobile: true } },
  { name: 'Android in Firefox', device: phone('Pixel 7'), platform: 'Linux armv81' },
];

async function open(browser: import('@playwright/test').Browser, visitor: Visitor) {
  const context = await browser.newContext(visitor.device);
  await context.addInitScript(({ platform, userAgentData }) => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => userAgentData });
  }, { platform: visitor.platform, userAgentData: visitor.userAgentData });
  const page = await context.newPage();
  await page.goto(SITE);
  return { context, page };
}

for (const visitor of phones) {
  test(`on ${visitor.name}, the steps are for the computer, with every system offered`, async ({ browser }) => {
    const { context, page } = await open(browser, visitor);
    const note = page.locator('#detected');
    await expect(note).toHaveText("You're on a phone or tablet. These steps are for the computer that will run OpenChessCoach: pick its system.");
    await expect(page.getByRole('tablist', { name: 'Your system' }).getByRole('tab')).toHaveText(['Windows', 'macOS', 'Linux']);
    await context.close();
  });
}

test('on a Mac, it shows the macOS steps and says why', async ({ browser }) => {
  const { context, page } = await open(browser, {
    name: 'a Mac',
    device: { viewport: { width: 1280, height: 800 }, userAgent: MAC_SAFARI },
    platform: 'MacIntel',
  });
  await expect(page.getByRole('tab', { name: 'macOS' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#detected')).toHaveText('Showing the steps for macOS, the system this page was opened on. Install on your desktop or laptop, not your phone.');
  await context.close();
});
