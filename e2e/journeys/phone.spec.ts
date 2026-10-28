// Feature map: Play on your phone. Most people play chess on their phone, so a desktop browser asks
// the Player to pair one: first run's first step on a fresh install, and a reminder on the main
// menu for a Player who never did. "I'll do it later" asks again in a few days; "Don't ask again"
// never does; a phone or tablet never asks. (A phone that connects is a paired phone, so the
// desktop stops asking everywhere too: the phone's own checks show what it sees, not that it
// would hold back on its own.)
import { type Browser, type BrowserContextOptions, devices, type Page } from '@playwright/test';
import { ASK_AGAIN_MS } from '../../packages/backend/src/phone.ts';
import { connection, expect, phoneLater, test, type AppFixture } from '../fixtures/app.ts';

const DAY = 24 * 60 * 60 * 1000;

const reminder = (page: Page) => page.getByRole('dialog', { name: 'Play on your phone' });
const menu = (page: Page) => page.getByRole('navigation', { name: 'Main menu' });

/** A pairing code as the app shows it: in groups of four. */
const grouped = (code: string): string => code.replace(/(.{4})(?!$)/g, '$1 ');

const device = (name: string): BrowserContextOptions => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name]!;
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
};

/** A phone or tablet (an iPhone unless told otherwise) that scanned the QR code: it opens the pairing link. */
async function phoneScans(browser: Browser, app: AppFixture, options = device('iPhone 13')): Promise<Page> {
  const context = await browser.newContext(options);
  const phone = await context.newPage();
  await phone.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(phone)).toHaveText(/Desktop connected/);
  return phone;
}

/**
 * Reloads, then waits for the desktop's answer on whether to ask, and for the page to act on it:
 * the reminder being hidden before that answer would prove nothing.
 */
async function reloadAndHearBack(page: Page): Promise<void> {
  const socket = page.waitForEvent('websocket');
  await page.reload();
  await (await socket).waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes('"phone":{"paired"') });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(menu(page)).toBeVisible();
}

/** When the desktop will ask again, as stored: an ISO time, or `never`; undefined if never put off. */
async function askAgain(app: AppFixture): Promise<string | undefined> {
  const meta = await app.rows<{ key: string; value: string }>('meta');
  return meta.find((m) => m.key === 'phone_reminder')?.value;
}

test.describe('a fresh install', () => {
  test.use({ seed: 'empty' });

  test('a desktop asks for the phone first, says when it pairs, and the phone carries on setting up', async ({ page, app, browser }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(page.getByRole('heading', { name: 'Welcome to your chess Coach' })).toBeVisible();
    const step = page.getByRole('region', { name: 'Play on your phone' });
    await expect(step).toContainText('Step 1 of 2');
    await expect(step.getByRole('figure', { name: 'Pairing QR code' })).toBeVisible();
    await expect(step.getByRole('listitem')).toHaveText([/same Wi-Fi/, /camera/, /Tap the link/]);
    // A phone whose camera opens no link types the code instead.
    await step.getByText('No link appears?').click();
    await expect(step.getByTestId('phone-pairing-code')).toHaveText(grouped(app.code));
    // The Player's questions wait for the second step.
    await expect(page.getByRole('radio', { name: /Beginner/ })).toHaveCount(0);

    // The phone starts at the Player's questions: it never asks for a phone.
    const phone = await phoneScans(browser, app);
    await expect(phone.getByText('Tell the Coach a little about yourself.')).toBeVisible();
    await expect(phone.getByRole('region', { name: 'Play on your phone' })).toHaveCount(0);
    await expect(phone.getByText('Step 2 of 2')).toHaveCount(0);

    // The desktop sees it pair, without a reload, and the focus, on the disclosure that went with
    // the QR code, moves to the button that replaced it.
    await expect(step.getByRole('status')).toContainText('Your phone is paired.');
    await expect(step.getByRole('figure', { name: 'Pairing QR code' })).toHaveCount(0);
    await expect(step.getByRole('button', { name: 'Continue here' })).toBeFocused();
    const names = (await app.rows<{ name: string; revoked_at: string | null }>('devices')).map((d) => d.name);
    expect(names).toContain('iPhone or iPad browser');

    // The Player finishes on the phone; the desktop then goes to the menu rather than asking again.
    await phone.getByRole('radio', { name: /Club/ }).check();
    await phone.getByRole('button', { name: 'Skip to the main menu' }).click();
    await expect(menu(phone)).toBeVisible();
    await expect(reminder(phone)).toBeHidden();
    await step.getByRole('button', { name: 'Continue here' }).click();
    await expect(menu(page)).toBeVisible();
    await expect(reminder(page)).toBeHidden();
    const [profile] = await app.rows<{ onboarded: number; level: string }>('profile');
    expect(profile).toMatchObject({ onboarded: 1, level: 'club' });
    await phone.context().close();
  });

  test('"Continue here" goes on to the Player\'s questions when the phone hasn\'t answered them', async ({ page, app, browser }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    const phone = await phoneScans(browser, app);
    const step = page.getByRole('region', { name: 'Play on your phone' });
    await step.getByRole('button', { name: 'Continue here' }).click();
    await expect(page.getByText('Step 2 of 2')).toBeVisible();
    await page.getByRole('button', { name: 'Skip to the main menu' }).click();
    await expect(menu(page)).toBeVisible();
    await expect(reminder(page)).toBeHidden();
    await phone.context().close();
  });

  test('"I\'ll do it later" goes on to the Player\'s questions, and the main menu asks again in a few days', async ({ page, app }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await phoneLater(page);
    await expect(page.getByText('Step 2 of 2')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'About you' })).toBeFocused();
    expect(await askAgain(app)).toBe(new Date(app.clock.now().getTime() + ASK_AGAIN_MS).toISOString());
    await page.getByRole('button', { name: 'Skip to the main menu' }).click();
    await expect(menu(page)).toBeVisible();
    await expect(reminder(page)).toBeHidden();

    app.clock.advance(ASK_AGAIN_MS);
    await page.reload();
    await expect(reminder(page)).toBeVisible();
  });
});

test.describe('an Android tablet that asks for desktop sites, as Chrome on a large one does', () => {
  test.use({ seed: 'no-phone' });

  test('counts as a phone, though it calls itself Linux', async ({ paired, app, browser }) => {
    await expect(reminder(paired)).toBeVisible();
    const linuxChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
    const tablet = await phoneScans(browser, app, { ...device('Galaxy Tab S4'), userAgent: linuxChrome });
    await expect(menu(tablet)).toBeVisible();
    await expect(reminder(tablet)).toBeHidden();
    await expect(reminder(paired).getByRole('status')).toContainText('Your phone is paired.');
    const names = (await app.rows<{ name: string }>('devices')).map((d) => d.name);
    expect(names).toContain('Android browser');
    await tablet.context().close();
  });
});

test.describe('a Player who never paired a phone', () => {
  test.use({ seed: 'no-phone' });

  test('the main menu asks, with the codes hidden until asked for; "I\'ll do it later" asks again in a few days', async ({ paired, app }) => {
    const dialog = reminder(paired);
    await expect(dialog).toBeVisible();
    // Read from the top: focus starts on the heading.
    await expect(dialog.getByRole('heading', { name: 'Play on your phone' })).toBeFocused();
    // It opened unasked, perhaps on a screen share: nothing that pairs a device is on the page yet.
    await expect(dialog.getByRole('figure', { name: 'Pairing QR code' })).toHaveCount(0);
    await expect(dialog.getByTestId('phone-pairing-code')).toHaveCount(0);
    expect(await paired.content()).not.toContain(app.code);
    await dialog.getByRole('button', { name: 'Show the code' }).click();
    await expect(dialog.getByRole('figure', { name: 'Pairing QR code' })).toBeVisible();
    await expect(dialog.getByText('No link appears?')).toBeFocused();
    await dialog.getByText('No link appears?').click();
    await expect(dialog.getByTestId('phone-pairing-code')).toHaveText(grouped(app.code));
    await dialog.getByRole('button', { name: 'I’ll do it later' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => askAgain(app)).toBe(new Date(app.clock.now().getTime() + ASK_AGAIN_MS).toISOString());

    // Not again on the next visit, nor the day before it is due.
    await reloadAndHearBack(paired);
    await expect(reminder(paired)).toBeHidden();
    app.clock.advance(ASK_AGAIN_MS - DAY);
    await reloadAndHearBack(paired);
    await expect(reminder(paired)).toBeHidden();
    app.clock.advance(DAY);
    await paired.reload();
    await expect(reminder(paired)).toBeVisible();
  });

  test('Escape counts as "I\'ll do it later"', async ({ paired, app }) => {
    await expect(reminder(paired)).toBeVisible();
    await paired.keyboard.press('Escape');
    await expect(reminder(paired)).toBeHidden();
    await expect.poll(() => askAgain(app)).toBe(new Date(app.clock.now().getTime() + ASK_AGAIN_MS).toISOString());
    // Back to the menu from another screen: still not asked.
    await paired.getByRole('link', { name: 'Settings' }).click();
    await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
    await expect(menu(paired)).toBeVisible();
    await expect(reminder(paired)).toBeHidden();
  });

  test('"Don\'t ask again" never asks again', async ({ paired, app }) => {
    await reminder(paired).getByRole('button', { name: 'Don’t ask again' }).click();
    await expect(reminder(paired)).toBeHidden();
    await expect.poll(() => askAgain(app)).toBe('never');
    app.clock.advance(365 * DAY);
    await reloadAndHearBack(paired);
    await expect(reminder(paired)).toBeHidden();
  });

  test('the reminder says when the phone pairs, and the phone itself is never asked', async ({ paired, app, browser }) => {
    const dialog = reminder(paired);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'I’ll do it later' }).focus();
    const phone = await phoneScans(browser, app);
    await expect(menu(phone)).toBeVisible();
    await expect(reminder(phone)).toBeHidden();

    // The news comes whether or not the codes were shown on this desktop: here they never were.
    await expect(dialog.getByRole('status')).toContainText('Your phone is paired.');
    await expect(dialog.getByRole('button', { name: 'Show the code' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'I’ll do it later' })).toHaveCount(0);
    // The focused button went: the focus stays in the dialog, on the one that replaced it.
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    // Nothing put off: the paired phone is what stops the asking.
    expect(await askAgain(app)).toBeUndefined();
    await reloadAndHearBack(paired);
    await expect(reminder(paired)).toBeHidden();
    await phone.context().close();
  });

  test('on a narrow window the reminder fits, its buttons in reach', async ({ page, app }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${app.url}/#pair=${app.code}`);
    const dialog = reminder(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'I’ll do it later' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // With the QR code shown it still fits, scrolling inside the dialog.
    await dialog.getByRole('button', { name: 'Show the code' }).click();
    await dialog.getByRole('figure', { name: 'Pairing QR code' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('figure', { name: 'Pairing QR code' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test('a pairing reset unpairs the phone, so the main menu asks again at once', async ({ paired }) => {
  await reloadAndHearBack(paired);
  await expect(reminder(paired)).toBeHidden();
  await paired.getByRole('link', { name: 'Settings' }).click();
  const pairing = paired.getByRole('region', { name: 'Pairing' });
  await pairing.getByRole('button', { name: 'Reset pairing' }).click();
  await pairing.getByRole('button', { name: 'Yes, reset pairing' }).click();
  await expect(pairing.getByRole('status')).toContainText('Pairing reset.');
  await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
  await expect(reminder(paired)).toBeVisible();
});
