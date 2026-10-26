// Feature map: Pairing (.claude/skills/verify/features/pairing.md). ADR 0001: nobody without the
// pairing code reaches the backend.
import { CoachClient, ProtocolError } from '../../packages/backend/src/client.ts';
import { connection, expect, test } from '../fixtures/app.ts';

/** A pairing code as Settings shows it: in groups of four. */
const grouped = (code: string): string => code.replace(/(.{4})(?!$)/g, '$1 ');

test('an unpaired visit is refused and shows the pairing screen', async ({ page, app }) => {
  await page.goto(app.url);
  await expect(page.getByRole('heading', { name: 'This device isn’t paired' })).toBeVisible();
  await expect(connection(page)).toHaveText(/Not paired/);
  // The backend refuses a socket without a valid token before upgrading it.
  await expect(CoachClient.connect(app.url, 'not-a-token')).rejects.toBeInstanceOf(ProtocolError);
  const devices = await app.rows('devices');
  expect(devices).toHaveLength(1); // only the readiness handshake's device
});

test('a wrong code is refused with a clear error', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByLabel('Pairing code').fill('WRONGCODE123');
  await page.getByRole('button', { name: 'Pair this device' }).click();
  await expect(page.getByRole('alert')).toHaveText(/wrong or has been reset/);
  expect(await app.rows('devices')).toHaveLength(1);
});

test('the QR link pairs the browser and it stays paired after a reload', async ({ page, app }) => {
  await page.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
  await page.reload();
  await expect(connection(page)).toHaveText(/Desktop connected/);
  const devices = await app.rows<{ name: string; revoked_at: string | null }>('devices');
  expect(devices).toHaveLength(2);
  expect(devices.every((d) => d.revoked_at === null)).toBe(true);
});

test('the QR link pairs a tab that is already showing the pairing screen', async ({ page, app }) => {
  await page.goto(app.url);
  await expect(page.getByRole('heading', { name: 'This device isn’t paired' })).toBeVisible();
  // Same document, new hash: what the browser does when the link opens in this tab.
  await page.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  expect(page.url()).not.toContain(app.code);
});

test('typing the code pairs the browser', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByLabel('Pairing code').fill(app.code.toLowerCase().replace(/(.{4})/g, '$1 '));
  await page.getByRole('button', { name: 'Pair this device' }).click();
  await expect(connection(page)).toHaveText(/Desktop connected/);
});

test('resetting pairing revokes every other device', async ({ paired, app, browser }) => {
  const other = await browser.newPage();
  await other.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(other)).toHaveText(/Desktop connected/);

  await paired.goto(`${app.url}/#/settings`);
  const pairing = paired.getByRole('region', { name: 'Pairing' });
  await pairing.getByRole('button', { name: 'Reset pairing' }).click();
  await pairing.getByRole('button', { name: 'Yes, reset pairing' }).click();
  // Said in the Pairing card, beside the button, which now shows the new code.
  await expect(pairing.getByRole('status')).toContainText('Pairing reset.');
  await expect(pairing.getByTestId('pairing-code')).not.toHaveText(grouped(app.code));
  // The device that asked keeps working with a fresh token; the other one is unpaired.
  await expect(other.getByRole('heading', { name: 'This device isn’t paired' })).toBeVisible();
  await paired.reload();
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  const devices = await app.rows<{ revoked_at: string | null }>('devices');
  expect(devices.filter((d) => d.revoked_at === null)).toHaveLength(1);
  // The old code no longer pairs.
  const res = await fetch(`${app.url}/api/pair`, { method: 'POST', body: JSON.stringify({ code: app.code }) });
  expect(res.status).toBe(401);
  await other.close();
});

test('Settings shows the pairing code, and a device without a camera pairs by typing it', async ({ paired, app, browser }) => {
  await paired.goto(`${app.url}/#/settings`);
  const pairing = paired.getByRole('region', { name: 'Pairing' });
  await expect(pairing.getByTestId('pairing-code')).toHaveText(grouped(app.code));
  await expect(pairing.getByTestId('pairing-link')).toHaveText(new RegExp(`/#pair=${app.code}$`));

  const laptop = await browser.newPage();
  await laptop.goto(app.url);
  await laptop.getByLabel('Pairing code').fill((await pairing.getByTestId('pairing-code').textContent()) ?? '');
  await laptop.getByRole('button', { name: 'Pair this device' }).click();
  await expect(connection(laptop)).toHaveText(/Desktop connected/);
  await laptop.close();
});

test('away-from-home access starts a tunnel and shows its pairing address', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/settings`);
  await paired.getByRole('checkbox', { name: 'Make the app reachable away from home' }).check();
  await expect(paired.getByTestId('tunnel-url')).toHaveText(/verify-mode\.trycloudflare\.com/);
  await paired.getByRole('checkbox', { name: 'Make the app reachable away from home' }).uncheck();
  await expect(paired.getByTestId('tunnel-url')).toHaveCount(0);
});

test('when the Coach is unavailable the app says why and keeps the board working', async ({ paired, app }) => {
  await fetch(`${app.url}/__verify/coach/status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${app.token}` },
    body: JSON.stringify({ unavailable: 'Claude Code is not logged in on the desktop.' }),
  });
  await paired.goto(`${app.url}/#/board`);
  const panel = paired.getByRole('region', { name: 'Coach' });
  await expect(panel).toContainText('Coach unavailable');
  await expect(panel).toContainText('Claude Code is not logged in on the desktop.');
  await expect(paired.getByRole('button', { name: 'Ask the Coach why' })).toBeDisabled();
  await paired.getByRole('button', { name: /^e2,/ }).click();
  await paired.getByRole('button', { name: /^e4,/ }).click();
  await expect(paired.getByRole('button', { name: /^Move 1\. e4, Best$/ })).toBeVisible();
});
