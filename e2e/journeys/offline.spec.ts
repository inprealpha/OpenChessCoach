// Feature map: Offline mode. With the desktop unreachable, the app still opens from its cache,
// an Engine Game can be played, and the finished game is saved once the desktop is back. A Lesson
// finished offline shows as complete in the Lessons, and its progress is sent when the desktop is back.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startVerifyInstance, type VerifyInstance } from '../../packages/backend/src/verify/instance.ts';
import type { Page } from '@playwright/test';
import { suggestNext, type CatalogueItem } from '../../packages/shared/src/content/course.ts';
import { decisions, type LessonData } from '../../packages/shared/src/content/lessons.ts';
import { board, coachPanel, connection, engineGate, expect, fenOf, play, resign, storedOnDevice, test } from '../fixtures/app.ts';

/** Keeps the app's WebSockets within reach, so a journey can drop the connection as a Wi-Fi blip would. */
async function trackSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    (window as unknown as { sockets: WebSocket[] }).sockets = sockets;
    window.WebSocket = class extends window.WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
}

/** A blip: the connection drops with the desktop still up, as when the heartbeat gives up on a silent one. */
async function blip(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { sockets: WebSocket[] }).sockets.at(-1)?.close());
}

test('an Engine Game played offline is saved when the desktop comes back', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  let app: VerifyInstance = await startVerifyInstance({ dataDir });
  const port = app.app.port;
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    // Wait for the offline app shell to be cached and in control of the page.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect(connection(page)).toHaveText(/Desktop connected/);

    await app.stop({ keepData: true });
    await page.reload();
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(page.getByRole('note')).toContainText('Your desktop can’t be reached');
    // The main menu says which of its choices work without the desktop.
    const choice = (name: string) => page.getByRole('navigation', { name: 'Main menu' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(choice('Play a game')).toContainText('Works without your desktop');
    await expect(choice('Learn')).toContainText('Works without your desktop');
    await expect(choice('Review your games')).toContainText('Needs your desktop');

    // Coach features are greyed out while the board keeps working.
    await page.goto(`${app.url}/#/board`);
    await expect(page.getByRole('region', { name: 'Coach' })).toContainText('Coach unavailable');
    await expect(page.getByRole('button', { name: 'Ask the Coach why' })).toBeDisabled();
    // The Winning Chances bar comes from the browser Engine, so it works with the desktop off (ADR 0007).
    await expect(page.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');

    await page.goto(`${app.url}/#/engine-game`);
    await page.getByRole('button', { name: 'Start the Engine Game' }).click();
    await play(page, 'e2e4', 'Engine Game board');
    await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
    await resign(page);
    await expect(page.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
    await expect(page.getByText(/^Saved on this device\./)).toBeVisible();
    // No Review link while the game waits on this device: focus carries on from New game.
    await expect(page.getByRole('button', { name: 'New game' })).toBeFocused();

    app = await startVerifyInstance({ dataDir, port });
    await expect(connection(page)).toHaveText(/Desktop connected/, { timeout: 30_000 });
    await expect
      .poll(() => app.app.db.prepare("SELECT result, player_side FROM games WHERE kind = 'engine'").all(), { timeout: 15_000 })
      .toEqual([{ result: '0-1', player_side: 'white' }]);
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the game list says the desktop can’t be reached rather than "No games yet"', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  let app: VerifyInstance = await startVerifyInstance({ dataDir });
  const port = app.app.port;
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    // Never opened while online, so this device has no copy of the list.
    await app.stop({ keepData: true });
    await page.goto(`${app.url}/#/games`);
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(page.getByRole('note')).toHaveText('Your games live on your desktop, which can’t be reached right now.');
    await expect(page.getByText('No games yet')).toHaveCount(0);

    // Opened once while online: the list from then is shown, and says where it came from.
    app = await startVerifyInstance({ dataDir, port });
    await expect(connection(page)).toHaveText(/Desktop connected/, { timeout: 30_000 });
    await expect(page.getByRole('table', { name: 'Game list' }).getByRole('row')).toHaveCount(2);
    await expect(page.getByRole('note')).toHaveCount(0);
    // The Player Profile is kept for offline use too.
    await expect.poll(() => storedOnDevice(page, 'profile')).toMatchObject({ onboarded: true });
    await app.stop({ keepData: true });
    await page.reload();
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(page.getByRole('note')).toHaveText(
      'Your games live on your desktop, which can’t be reached right now. This is the list from the last time it could.',
    );
    await expect(page.getByRole('table', { name: 'Game list' }).getByRole('row')).toHaveCount(2);

    // On the menu, importing needs the desktop too: Import more is greyed out, not a link to a dead end.
    await page.getByRole('link', { name: 'OpenChessCoach' }).click();
    const reviewYourGames = page.getByRole('navigation', { name: 'Main menu' }).getByRole('listitem').filter({ hasText: 'Review your games' });
    await expect(reviewYourGames.getByRole('link', { name: 'Import more', disabled: true })).toBeVisible();
    await expect(reviewYourGames.getByRole('link', { name: 'Import more' })).not.toHaveAttribute('href');
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('offline, a Review says it needs the desktop, and opens once the desktop is back', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  let app: VerifyInstance = await startVerifyInstance({ dataDir });
  const port = app.app.port;
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    // The game list is kept on this device once shown.
    await page.goto(`${app.url}/#/games`);
    await expect(page.getByRole('table', { name: 'Game list' }).getByRole('row')).toHaveCount(2);
    await expect.poll(() => storedOnDevice(page, 'games')).toMatchObject({ total: 1 });

    await app.stop({ keepData: true });
    await page.goto(`${app.url}/#/review/1`);
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(page.getByRole('note')).toHaveText('Reviews live on your desktop, which can’t be reached right now. This one opens here once it is back.');
    // The game as this device kept it, so the Player knows which one it is.
    await expect(page.getByText('bijean vs ikatsca · 0-1 · Italian Game: Giuoco Piano, Greco\'s Attack · 2013-01-05')).toBeVisible();
    await expect(page.getByText('Loading the game…')).toHaveCount(0);

    app = await startVerifyInstance({ dataDir, port });
    await expect(connection(page)).toHaveText(/Desktop connected/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Start the Review' })).toBeVisible();
    await expect(page.getByRole('note')).toHaveCount(0);
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a connection that drops and comes back leaves a Review where the Player was', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  let app: VerifyInstance = await startVerifyInstance({ dataDir });
  const port = app.app.port;
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/review/1`);
    await page.getByRole('button', { name: 'Start the Review' }).click();
    const show = page.getByRole('button', { name: 'Show moment: move 12. Bg5, Mistake' });
    await expect(show).toBeVisible({ timeout: 90_000 });
    // Studying the moment 12. Bg5: the position before it.
    await show.click();
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    const current = page.getByRole('figure', { name: 'Winning Chances graph' }).getByRole('img', { name: /^Current position: / });
    await expect(current).toHaveAccessibleName(/^Current position: 11… Rxf7: /);
    const fen = await fenOf(page, 'Review board');

    await app.stop({ keepData: true });
    await expect(connection(page)).toHaveText(/Desktop offline/);
    app = await startVerifyInstance({ dataDir, port });
    await expect(connection(page)).toHaveText(/Desktop connected/, { timeout: 30_000 });

    // Still the same moment, open on the same position.
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    await expect(current).toHaveAccessibleName(/^Current position: 11… Rxf7: /);
    expect(await fenOf(page, 'Review board')).toBe(fen);
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a Review being made rides out a dropped connection and finishes when the desktop is back', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  let app: VerifyInstance = await startVerifyInstance({ dataDir });
  const port = app.app.port;
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/review/1`);
    await page.getByRole('button', { name: 'Start the Review' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Grading move/ })).toBeVisible();

    await app.stop({ keepData: true });
    await expect(page.getByRole('status').filter({ hasText: 'The connection to your desktop dropped. The Review goes on once it is back.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start the Review' })).toHaveCount(0);

    // Back: it finishes with no click, and opens its first key moment as a Review always does.
    app = await startVerifyInstance({ dataDir, port });
    const first = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first();
    await expect(first).toBeVisible({ timeout: 90_000 });
    await expect(first.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(app.app.db.prepare('SELECT game_id FROM reviews').all()).toEqual([{ game_id: 1 }]);
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a Review being made rides out a blip with the desktop still up, and the desktop makes it once', async ({ page, app }) => {
  await trackSockets(page);
  // Progress the desktop reports on a connection opened after the blip.
  let sockets = 0;
  let blipAt = Infinity;
  let joined = 0;
  page.on('websocket', (ws) => {
    const n = ++sockets;
    ws.on('framereceived', (f) => {
      if (n > blipAt && typeof f.payload === 'string' && f.payload.includes('"type":"progress"')) joined++;
    });
  });
  const engine = engineGate(app);
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/review/1`);
    await page.getByRole('button', { name: 'Start the Review' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Grading move [1-9]/ })).toBeVisible();

    // The Engine is mid-position when the connection drops, as it is at the desktop's own depth.
    engine.hold();
    blipAt = sockets;
    await blip(page);
    // Asked again on the new connection, the desktop goes on with the same Review and says how far it has got.
    await expect.poll(() => joined, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByRole('status').filter({ hasText: /Grading move [1-9]/ })).toBeVisible();
    engine.release();

    const first = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first();
    await expect(first).toBeVisible({ timeout: 90_000 });
    await expect(first.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await app.rows('reviews')).toHaveLength(1);
    expect(await app.rows<{ job: string }>('coach_calls').then((r) => r.filter((c) => c.job === 'review-moment'))).toHaveLength(4);
  } finally {
    engine.release();
  }
});

test('offline, a long game list shows the games this device was shown, with no Show more', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  const app: VerifyInstance = await startVerifyInstance({ dataDir, seed: 'many-games' });
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.goto(`${app.url}/#/games`);
    const table = page.getByRole('table', { name: 'Game list' });
    await expect(table.getByRole('row')).toHaveCount(51);
    await expect.poll(async () => ((await storedOnDevice(page, 'games')) as { games?: unknown[] } | null)?.games?.length).toBe(50);

    await app.stop({ keepData: true });
    await page.reload();
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(page.getByRole('note')).toHaveText(
      'Your games live on your desktop, which can’t be reached right now. This is the list from the last time it could.',
    );
    await expect(table.getByRole('row')).toHaveCount(51);
    await expect(page.getByText('Showing 50 of 61 games.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the multi-threaded Engine starts on a page the offline app shell controls', async ({ paired }) => {
  // The build's thread workers load the Engine script with a URL fragment that tells them they
  // are threads. A cached response must not lose it, or every thread starts a whole new Engine.
  await paired.evaluate(() => navigator.serviceWorker.ready);
  await paired.reload();
  await expect.poll(() => paired.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  expect(await paired.evaluate(() => crossOriginIsolated)).toBe(true);

  const result = await paired.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const worker = new Worker('/engine/stockfish-18-lite.js');
        const timer = setTimeout(() => {
          worker.terminate();
          resolve('no answer');
        }, 20_000);
        worker.onmessage = (e: MessageEvent) => {
          const line = String(e.data);
          if (line === 'uciok') worker.postMessage('setoption name Threads value 4');
          if (line === 'uciok') worker.postMessage('isready');
          if (line === 'readyok') worker.postMessage('go depth 8');
          if (line.startsWith('bestmove')) {
            clearTimeout(timer);
            worker.terminate();
            resolve(line.split(' ')[1] ?? '');
          }
        };
        worker.postMessage('uci');
      }),
  );
  expect(result).toMatch(/^[a-h][1-8][a-h][1-8]/);
});

test.describe('a tab left open across an update', () => {
  // The service worker would serve the cached chunk; with it out of the way the test can take the
  // chunk away, as the update does for a tab still running the previous build.
  test.use({ serviceWorkers: 'block' });
  const lessonChunk = /\/assets\/italian-game-[^/]+\.js$/;
  const navigationType = (page: Page) => page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type);

  test('reloads once to fetch the new app when the previous build’s chunk is gone', async ({ paired, app }) => {
    let asked = 0;
    await paired.route(lessonChunk, (route) => (asked++ === 0 ? route.fulfill({ status: 404, body: 'Not found' }) : route.continue()));
    await paired.goto(`${app.url}/#/lesson/italian-game`);
    await expect(paired.getByRole('heading', { name: 'Italian Game' })).toBeVisible();
    expect(asked).toBe(2);
    expect(await navigationType(paired)).toBe('reload');
  });

  test('reloads only once when the chunk stays out of reach', async ({ paired, app }) => {
    let asked = 0;
    await paired.route(lessonChunk, (route) => {
      asked++;
      return route.fulfill({ status: 404, body: 'Not found' });
    });
    await paired.goto(`${app.url}/#/lesson/italian-game`);
    await expect.poll(() => asked).toBe(2);
    await expect.poll(() => navigationType(paired)).toBe('reload');
    // No reload loop: the page stays put.
    await paired.waitForTimeout(3000);
    expect(asked).toBe(2);
  });

  test('stays in the app when a chunk fails because the desktop is out of reach', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board`);
    await expect(connection(paired)).toHaveText(/Desktop connected/);
    const asked: string[] = [];
    await paired.route('**/*', (route) => {
      asked.push(new URL(route.request().url()).pathname);
      return route.abort('internetdisconnected');
    });
    await paired.evaluate(() => (location.hash = '#/lesson/italian-game'));
    // The chunk fails, the check that the desktop answers fails, and the page stays put.
    await expect.poll(() => asked.some((p) => lessonChunk.test(p)) && asked.includes('/')).toBe(true);
    await paired.waitForTimeout(2000);
    // No reload into the browser's error page: the Board still works on the browser's Engine.
    expect(paired.url()).toContain(app.url);
    expect(await navigationType(paired)).not.toBe('reload');
    await paired.evaluate(() => (location.hash = '#/board'));
    await expect(board(paired)).toBeVisible();
  });
});

test.describe('a desktop that goes silent', () => {
  // The desktop's HTTP is blocked below with page.route, which can't see requests a service worker handles.
  test.use({ serviceWorkers: 'block' });

  test('a desktop that goes silent without closing the connection is noticed, and the app reconnects', async ({ page, app }) => {
    // A desktop that goes to sleep or drops off the Wi-Fi leaves the connection open but silent,
    // and refuses new ones: relay the app's connection, then stop relaying without closing it.
    let silent = false;
    await page.routeWebSocket(/\/ws\b/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        if (!silent) server.send(m);
      });
      server.onMessage((m) => {
        if (!silent) ws.send(m);
      });
    });
    await page.route(/\/api\//, (route) => (silent ? route.abort('connectionrefused') : route.continue()));
    await page.clock.install();
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/board`);
    await play(page, 'e2e4');
    await expect(page.getByRole('button', { name: 'Ask the Coach why' })).toBeEnabled();

    silent = true;
    await page.getByRole('button', { name: 'Ask the Coach why' }).click();
    // Within 20 seconds the app stops waiting: it says the desktop is offline and the question fails.
    await page.clock.runFor('00:20');
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(coachPanel(page)).toContainText('Your desktop can’t be reached');

    // The desktop wakes up: the app reconnects by itself.
    silent = false;
    await page.clock.runFor('00:15');
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await expect(page.getByRole('button', { name: 'Ask the Coach why' })).toBeEnabled();
  });

  test('on a phone, a Player Profile save the silent desktop never answers says so beside Save, and the greyed-out buttons say why', async ({ page, app }) => {
    let silent = false;
    await page.routeWebSocket(/\/ws\b/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        if (!silent) server.send(m);
      });
      server.onMessage((m) => {
        if (!silent) ws.send(m);
      });
    });
    await page.route(/\/api\//, (route) => (silent ? route.abort('connectionrefused') : route.continue()));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/profile`);
    const card = page.getByRole('region', { name: 'Level, account and Goals' });
    await card.getByRole('button', { name: 'Link an account' }).click();
    await card.getByLabel('Site').selectOption('lichess');
    await card.getByLabel('Username').fill('CoachVerify');

    silent = true;
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('button', { name: 'Checking Lichess…' })).toBeDisabled();
    await page.clock.runFor('00:20');
    await expect(connection(page)).toHaveText(/Desktop offline/);
    const error = card.getByRole('alert');
    await expect(error).toHaveText('Not saved: your desktop can’t be reached right now. Save again once it’s back.');
    await expect(error).toBeInViewport();
    await expect(page.getByRole('alert')).toHaveCount(1);
    // The form keeps what the Player typed.
    await expect(card.getByLabel('Username')).toHaveValue('CoachVerify');

    await card.getByRole('button', { name: 'Cancel' }).click();
    const note = page.getByRole('note');
    await expect(note).toHaveText('Your Player Profile lives on your desktop, which can’t be reached right now. You can change it once it’s back.');
    await expect(card.getByRole('button', { name: 'Link an account' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Edit level, account and Goals' })).toBeDisabled();

    silent = false;
    await page.clock.runFor('00:15');
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await expect(note).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Edit level, account and Goals' })).toBeEnabled();
    await expect(card).toContainText('Rating: not linked');
    expect((await app.rows<{ rating: number | null }>('profile'))[0]?.rating).toBeNull();
  });
});

test('a browser without AbortSignal.timeout (Safari 15) still connects to the desktop', async ({ page, app }) => {
  // iOS 15 phones have no AbortSignal.timeout; calling it would throw and keep the app offline.
  await page.addInitScript(() => {
    delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
  });
  await page.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
});

test('a Lesson finished offline shows as complete in the Lessons, and its progress reaches the desktop once it is back', async ({ page }) => {
  const index = JSON.parse(readFileSync(new URL('../../data/lessons/index.json', import.meta.url), 'utf8')) as CatalogueItem[];
  // The seed's Player is at casual level, with no rating linked.
  const player = { level: 'casual', rating: null } as const;
  const first = suggestNext(index, [], player)!.lesson;
  const then = suggestNext(index, [{ lessonId: first.id, step: first.decisions, completed: true, updatedAt: '' }], player)!.lesson;
  const steps = decisions(JSON.parse(readFileSync(new URL(`../../data/lessons/${first.id}.json`, import.meta.url), 'utf8')) as LessonData);
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-offline-'));
  let app: VerifyInstance = await startVerifyInstance({ dataDir });
  const port = app.app.port;
  const completed = () => app.app.db.prepare('SELECT completed FROM lesson_progress WHERE lesson_id = ?').get(first.id) as { completed: number } | undefined;
  try {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    // One decision from the end, then the desktop goes away while the Lesson is open.
    app.app.db
      .prepare('INSERT INTO lesson_progress (lesson_id, step, completed, updated_at) VALUES (?, ?, 0, ?)')
      .run(first.id, steps.length - 1, '2026-10-01T10:00:00.000Z');
    await page.goto(`${app.url}/#/lessons`);
    await expect(page.getByRole('link', { name: `${first.name}: ${steps.length - 1} of ${first.decisions} decisions` })).toBeVisible();
    await page.goto(`${app.url}/#/lesson/${first.id}`);
    await expect(page.getByRole('button', { name: 'Resume the Lesson' })).toBeVisible();
    await app.stop({ keepData: true });
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await page.getByRole('button', { name: 'Resume the Lesson' }).click();
    await play(page, steps[steps.length - 1]!.node.main, `${first.name} Lesson board`);
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByRole('region', { name: 'Lesson complete' })).toBeVisible();

    // The Lessons count it complete and move the next Lesson on, though the desktop hasn't heard.
    await page.goto(`${app.url}/#/lessons`);
    await expect(connection(page)).toHaveText(/Desktop offline/);
    await expect(page.getByRole('link', { name: `${first.name}: Complete` })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your next Lesson' }).getByRole('heading', { name: then.name })).toBeVisible();

    // Back: the progress is sent with no Lesson opened.
    app = await startVerifyInstance({ dataDir, port });
    await expect(connection(page)).toHaveText(/Desktop connected/, { timeout: 30_000 });
    await expect.poll(() => completed()?.completed).toBe(1);
    await expect.poll(() => storedOnDevice(page, 'lessonProgressUnsent')).toEqual([]);
    await expect(page.getByRole('link', { name: `${first.name}: Complete` })).toBeVisible();
  } finally {
    await app.stop({ keepData: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
