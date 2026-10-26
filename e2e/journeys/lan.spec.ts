// Feature map: Pairing. The QR code opens the desktop's Wi-Fi address over plain http, which is not a
// secure origin: the browser offers no crypto.randomUUID, service worker or SharedArrayBuffer there.
// Every screen a phone reaches that way must still work.
import { networkInterfaces } from 'node:os';
import type { Locator, Page } from '@playwright/test';
import { board, connection, expect, play, test } from '../fixtures/app.ts';

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i?.family === 'IPv4' && !i.internal)?.address;

// Listen on every interface, as the desktop does for phones, and reach that address directly, as a
// phone on the same Wi-Fi does, even where the test machine sends other traffic through a proxy.
const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, lanAddress].filter(Boolean).join(',');
test.use({
  appOptions: { host: '0.0.0.0' },
  launchOptions: { env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy } },
});

/** Opens a screen; one that throws as it opens shows nothing, so fail with the page's errors. */
async function open(page: Page, url: string, ready: Locator, errors: string[]): Promise<void> {
  await page.goto(url);
  await ready.waitFor({ timeout: 15_000 }).catch(() => {
    throw new Error(`${new URL(url).hash} showed nothing. Page errors: ${errors.join(' | ') || 'none'}`);
  });
}

test('a phone on the desktop’s Wi-Fi address over http can use every screen with a board', async ({ page, app }) => {
  if (!lanAddress) throw new Error('This journey needs a network interface with an IPv4 address other than 127.0.0.1.');
  const url = app.url.replace('127.0.0.1', lanAddress);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}/#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  expect(await page.evaluate(() => isSecureContext)).toBe(false);

  await open(page, `${url}/#/board`, board(page), errors);
  await play(page, 'e2e4');
  await expect(page.getByRole('list', { name: 'Moves' })).toContainText('e4');

  await open(page, `${url}/#/engine-game`, page.getByRole('button', { name: 'Start the Engine Game' }), errors);
  await page.getByRole('button', { name: 'Start the Engine Game' }).click();
  await play(page, 'e2e4', 'Engine Game board');
  await expect(page.getByRole('status', { name: 'Game status' })).toContainText('Your move');

  await open(page, `${url}/#/lesson/italian-game`, page.getByRole('button', { name: 'Start the Lesson' }), errors);
  await page.getByRole('button', { name: 'Start the Lesson' }).click();
  await expect(page.getByRole('group', { name: 'Italian Game Lesson board' })).toBeVisible();
  await expect(page.getByLabel('Coach conversation')).toContainText('What are your options here?');

  await open(page, `${url}/#/puzzles/italian-game`, page.getByRole('region', { name: 'Puzzle' }), errors);
  await expect(page.getByRole('region', { name: 'Puzzle' })).toContainText('Find the best move for');

  await page.goto(`${url}/#/games`);
  await page.getByRole('link', { name: /^Review: ikatsca/ }).click();
  await page.getByRole('button', { name: 'Start the Review' }).click();
  await expect(page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first()).toBeVisible({ timeout: 90_000 });

  expect(errors).toEqual([]);
});
