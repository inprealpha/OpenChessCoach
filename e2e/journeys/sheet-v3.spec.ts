// PROTOTYPE (#80), Version 3 of the phone's panel sheet: an overlay, as in Apple Maps. Every page
// load carries `?sheet=3`. The board keeps its size and never moves; the sheet slides up over its
// lower part with the finger, and a spring settles it. Issue 80's "Done means", in their overlay form:
// where the issue says the board shrinks, these prove the board stays put and the sheet covers it.
// Chromium drives real touches (CDP); WebKit on Linux has no touch screen, so it gets synthetic
// TouchEvents, which can't make the browser scroll natively: there the journeys prove the sheet left
// the touch to the browser instead.
import { type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { coachIdle, connection, expect, play, test, type AppFixture } from '../fixtures/app.ts';

const SIZES = [
  [390, 664],
  [402, 714],
  [440, 790],
  [390, 844],
] as const;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const LONG =
  'Nf3 is the move this Lesson teaches, and it does two jobs at once. It develops a piece towards the centre, where a knight is strongest, and it attacks the pawn on e5 straight away, so Black has to spend the next move defending it. That is why it is played so often: it gains time. Notice too that the knight does not block your c-pawn or your bishop on f1, which is heading for c4 next, where it will aim at f7, the pawn that only the black king defends.';

type Kind = 'chromium' | 'webkit';

/** A finger on the screen: real touches in Chromium, synthetic TouchEvents in WebKit. */
interface Finger {
  /** `at`: when the touch screen saw it, in ms since the epoch (now if not given). */
  down(x: number, y: number, at?: number): Promise<void>;
  move(x: number, y: number, at?: number): Promise<void>;
  up(at?: number): Promise<void>;
  /** WebKit: whether the sheet took the last move from the browser (preventDefault). */
  prevented(): Promise<boolean>;
}

async function realFinger(page: Page): Promise<Finger> {
  const cdp = await page.context().newCDPSession(page);
  const when = (at?: number) => (at === undefined ? {} : { timestamp: at / 1000 });
  return {
    down: async (x, y, at) => void (await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], ...when(at) })),
    move: async (x, y, at) => void (await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }], ...when(at) })),
    up: async (at) => void (await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], ...when(at) })),
    prevented: async () => false,
  };
}

/** WebKit on Linux makes no Touch objects: an Event with touch lists does what the sheet reads. */
function syntheticFinger(page: Page): Finger {
  const send = (type: string, x: number, y: number, at?: number) =>
    page.evaluate(
      ({ type, x, y, at }) => {
        const w = window as unknown as { __finger?: { target: Element; x: number; y: number; prevented: boolean } };
        if (type === 'touchstart') w.__finger = { target: document.elementFromPoint(x, y)!, x, y, prevented: false };
        const f = w.__finger!;
        const t = { identifier: 7, target: f.target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
        const e = new Event(type, { bubbles: true, cancelable: true, composed: true });
        const list = type === 'touchend' ? [] : [t];
        Object.defineProperty(e, 'touches', { value: list });
        Object.defineProperty(e, 'targetTouches', { value: list });
        Object.defineProperty(e, 'changedTouches', { value: [t] });
        if (at !== undefined) Object.defineProperty(e, 'timeStamp', { value: at - performance.timeOrigin });
        f.target.dispatchEvent(e);
        if (type === 'touchmove') f.prevented = e.defaultPrevented;
        f.x = x;
        f.y = y;
      },
      { type, x, y, at },
    );
  let last = { x: 0, y: 0 };
  return {
    down: async (x, y, at) => {
      last = { x, y };
      await send('touchstart', x, y, at);
    },
    move: async (x, y, at) => {
      last = { x, y };
      await send('touchmove', x, y, at);
    },
    up: async (at) => send('touchend', last.x, last.y, at),
    prevented: () => page.evaluate(() => (window as unknown as { __finger: { prevented: boolean } }).__finger.prevented),
  };
}

/** A phone held upright, paired, on Version 3. */
async function phone(kind: Kind, browser: Browser, app: AppFixture, size: readonly [number, number] = SIZES[0]): Promise<{ page: Page; finger: Finger; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 2,
    hasTouch: true,
    ...(kind === 'chromium' ? { isMobile: true } : {}),
    userAgent: UA,
  });
  const page = await context.newPage();
  await page.goto(`${app.url}/?sheet=3#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  await expect(page.locator('html')).toHaveAttribute('data-sheet', 'v3');
  const finger = kind === 'chromium' ? await realFinger(page) : syntheticFinger(page);
  return { page, finger, context };
}

const go = (page: Page, app: AppFixture, hash: string) => page.goto(`${app.url}/?sheet=3${hash}`);
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

interface Geo {
  sheetTop: number;
  colTop: number;
  colBottom: number;
  band: number;
  /** Where the up detent is, below the card's top (the middle of the board): as high as the content needs. */
  upAt: number;
  boardTop: number;
  boardH: number;
  /** The Ask row's foot, if the Coach has one now (the Engine Game's take-back choice has none). */
  askBottom: number | null;
  board: string;
  scrollTop: number;
  room: number;
  logRoom: number;
  state: string;
  coachTop: number;
  coachBottom: number;
  layoutBottom: number;
  dim: number;
}

const geo = (page: Page): Promise<Geo> =>
  page.evaluate(() => {
    const side = document.querySelector<HTMLElement>('.side.panel')!;
    const col = document.querySelector<HTMLElement>('.board-col')!;
    const layout = col.parentElement!;
    const body = side.querySelector<HTMLElement>('.panel-body')!;
    const log = side.querySelector<HTMLElement>('.coach .log');
    // Puzzles has no Coach in its sheet until there is something to ask: then the screen's foot.
    const coach = side.querySelector<HTMLElement>(':scope > .coach')?.getBoundingClientRect() ?? { top: layout.getBoundingClientRect().bottom, bottom: layout.getBoundingClientRect().bottom };
    const b = col.querySelector<HTMLElement>('.board')!.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    return {
      sheetTop: side.getBoundingClientRect().top,
      colTop: c.top,
      colBottom: c.bottom,
      band: parseFloat(layout.style.getPropertyValue('--v3-band')),
      upAt: Number(layout.dataset.v3Up ?? 0),
      boardTop: b.top,
      boardH: b.height,
      askBottom: side.querySelector<HTMLElement>(':scope > .coach > .thumb-row')?.getBoundingClientRect().bottom ?? null,
      board: [b.x, b.y, b.width, b.height].map((n) => n.toFixed(1)).join(','),
      scrollTop: body.scrollTop,
      room: body.scrollHeight - body.clientHeight,
      logRoom: log ? log.scrollHeight - log.clientHeight : 0,
      state: side.dataset.v3 ?? '',
      coachTop: coach.top,
      coachBottom: coach.bottom,
      layoutBottom: layout.getBoundingClientRect().bottom,
      dim: Number(document.querySelector<HTMLElement>('.v3-scrim')?.style.opacity ?? 0),
    };
  });

const handle = (page: Page) => page.getByRole('button', { name: /^(Pull the panel up|Let the panel down)$/ });

/** The Ask row at the foot of the screen, whole; without one, the Coach's first lines show above the foot. */
function expectAskDocked(g: Geo): void {
  if (g.askBottom === null) {
    // (A Puzzle has no Coach in its sheet until there is something to ask.)
    if (g.coachTop < g.layoutBottom) expect(g.layoutBottom - g.coachTop).toBeGreaterThan(30);
    return;
  }
  expect(g.layoutBottom - g.askBottom).toBeGreaterThanOrEqual(-0.5);
  expect(g.layoutBottom - g.askBottom).toBeLessThanOrEqual(8);
}

async function expectRest(page: Page): Promise<Geo> {
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  // Settled: exactly at the board's foot, nothing dimmed.
  // (The settled state is marked a frame after the sheet arrives, when the app hears of it.)
  await expect.poll(async () => { const g = await geo(page); return Math.abs(g.sheetTop - g.colBottom) <= 0.1 && g.dim === 0 && g.state === 'rest'; }).toBe(true);
  const g = await geo(page);
  // The Ask box stays docked at the foot of the screen.
  expectAskDocked(g);
  expect(g.dim).toBe(0);
  return g;
}

async function expectUp(page: Page): Promise<Geo> {
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => { const g = await geo(page); return Math.abs(g.sheetTop - (g.colTop + g.band + g.upAt)) <= 0.1 && g.state === 'up'; }).toBe(true);
  const g = await geo(page);
  // At least the top half of the board stays in view, the sheet no higher than its content needs.
  expect(g.sheetTop - g.boardTop).toBeGreaterThanOrEqual(g.boardH / 2 - 1);
  expect(g.sheetTop).toBeLessThanOrEqual(g.colBottom - 119);
  expectAskDocked(g);
  expect(g.dim).toBeCloseTo(0.1, 2);
  return g;
}

/** Records the sheet's drawn top on every frame for a while: started before a release or a tap. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rec: number[]; __dt: number[] };
    w.__rec = [];
    w.__dt = [];
    const side = document.querySelector<HTMLElement>('.side.panel')!;
    const t0 = performance.now();
    let last = t0;
    const tick = (now: number) => {
      w.__rec.push(side.getBoundingClientRect().top);
      w.__dt.push(now - last);
      last = now;
      if (performance.now() - t0 < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The recorded move was animated: frame by frame, one way, no jump at its start or end. */
async function expectAnimated(page: Page, from: number, to: number, least = 4): Promise<void> {
  await page.waitForTimeout(950);
  const { tops, dts } = await page.evaluate(() => ({ tops: (window as unknown as { __rec: number[] }).__rec, dts: (window as unknown as { __dt: number[] }).__dt }));
  const span = to - from;
  const between = tops.filter((t) => (span > 0 ? t > from + 1 && t < to - 1 : t < from - 1 && t > to + 1));
  // Frames on the way: at 60 Hz the spring takes about 18. Headless WebKit on Linux renders in
  // software and can spend one long frame on the release, which the time-based spring then covers.
  expect(between.length, `frames between ${from} and ${to}: ${tops.map((t) => t.toFixed(0)).join(' ')}`).toBeGreaterThanOrEqual(least);
  for (let i = 1; i < tops.length; i++) {
    const step = tops[i]! - tops[i - 1]!;
    // Never back the other way (no bounce), and no frame on time covers a quarter of the way (no
    // jump). A late frame on a busy test machine moves the spring further, as time has passed; the
    // recorder reads the sheet before the spring's step in the same frame, so a step it sees is the
    // previous frame's.
    expect(step * Math.sign(span)).toBeGreaterThanOrEqual(-0.5);
    if (Math.max(dts[i]!, dts[i - 1]!, i > 1 ? dts[i - 2]! : 0) < 20) expect(Math.abs(step), `${from}→${to}: ${tops.map((t) => t.toFixed(0)).join(' ')}`).toBeLessThan(Math.abs(span) * 0.25);
  }
}

/**
 * A drag of `dy` px in `steps` moves, `ms` apart, from (x, y): returns the sheet's top, the
 * content's scroll and the board's box after each move. `release` lets go.
 */
async function drag(page: Page, finger: Finger, x: number, y: number, dy: number, steps: number, ms = 16, release = true) {
  const frames: { finger: number; sheetTop: number; scrollTop: number; board: string; prevented: boolean }[] = [];
  await finger.down(x, y);
  for (let i = 1; i <= steps; i++) {
    if (ms) await page.waitForTimeout(ms);
    const fy = y + (dy * i) / steps;
    await finger.move(x, fy);
    // Two frames: a busy machine may hand the move to the page a frame late.
    await frame(page);
    await frame(page);
    const g = await geo(page);
    frames.push({ finger: fy, sheetTop: g.sheetTop, scrollTop: g.scrollTop, board: g.board, prevented: await finger.prevented() });
  }
  if (release) await finger.up();
  return frames;
}

/** A quick flick: moves `ms` apart and the finger lifts straight after the last, as a real one does. */
async function flick(page: Page, finger: Finger, x: number, y: number, dy: number, steps = 3, ms = 12): Promise<void> {
  // Stamped as the touch screen would, so a busy test machine's delays don't turn it into a pause.
  const t0 = Date.now();
  await finger.down(x, y, t0);
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms);
    await finger.move(x, y + (dy * i) / steps, t0 + i * ms);
  }
  await finger.up(t0 + steps * ms + 8);
}

/** Between the first move that moved the sheet and the last, it moved exactly as far as the finger. */
function expectFollowed(frames: { finger: number; sheetTop: number }[], minMoves: number): void {
  const moved = frames.findIndex((f, i) => i > 0 && Math.abs(f.sheetTop - frames[i - 1]!.sheetTop) > 0.5);
  expect(moved, JSON.stringify(frames)).toBeGreaterThan(0);
  const following = frames.slice(moved - 1);
  expect(following.length - 1).toBeGreaterThanOrEqual(minMoves);
  for (let i = 1; i < following.length; i++) {
    expect(following[i]!.sheetTop - following[i - 1]!.sheetTop, JSON.stringify(frames)).toBeCloseTo(following[i]!.finger - following[i - 1]!.finger, 0);
  }
}

/** A button the resting sheet must show: on screen, whole, above the Ask box, and nothing over it. */
async function expectShownAtRest(page: Page, button: Locator): Promise<void> {
  await expect(button).toBeInViewport({ ratio: 1 });
  const { clear, hit } = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const coach = document.querySelector('.side.panel > .coach')?.getBoundingClientRect() ?? { top: innerHeight };
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { clear: r.bottom <= coach.top + 0.5, hit: el.contains(at) };
  });
  expect(clear, 'above the Ask box').toBe(true);
  expect(hit, 'nothing drawn over it').toBe(true);
}

const tapAt = async (page: Page, x: number, y: number) => page.touchscreen.tap(x, y);
async function tap(page: Page, el: Locator): Promise<void> {
  const b = (await el.boundingBox())!;
  await tapAt(page, b.x + b.width / 2, b.y + b.height / 2);
}

/** Lets the sheet down if a screen left it up, by the handle. */
async function toRest(page: Page): Promise<void> {
  if ((await handle(page).getAttribute('aria-expanded')) === 'true') await tap(page, handle(page));
  await expectRest(page);
}

interface Screen {
  /** Opens the screen in the state the journeys use, the sheet at rest. */
  open(page: Page, app: AppFixture, first: boolean): Promise<void>;
  /** What its resting sheet must show. */
  shown(page: Page): Locator[];
  /** A tap on a button in the sheet does its job. */
  tapButton(page: Page, least: number): Promise<void>;
}

const LESSON_BOARD = 'Italian Game Lesson board';
const SCREENS: Record<string, Screen> = {
  Lesson: {
    async open(page, app) {
      await go(page, app, '#/lessons');
      await go(page, app, '#/lesson/italian-game');
      await page.getByRole('button', { name: /Start the Lesson|Start from the beginning/ }).first().click();
      await app.script({ kind: 'reply', reply: { text: 'e4 takes the centre.' } });
      await play(page, 'e2e4', LESSON_BOARD);
      await page.getByRole('button', { name: 'Continue' }).click();
      await app.script({ kind: 'reply', reply: { text: LONG } });
      await play(page, 'g1f3', LESSON_BOARD);
      await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
      await coachIdle(page);
    },
    shown: (page) => [page.getByRole('button', { name: 'Continue' })],
    async tapButton(page) {
      await expect(page.locator('.head-line')).toContainText('Decision 2 of');
      await tap(page, page.getByRole('button', { name: 'Continue' }));
      await expect(page.locator('.head-line')).toContainText('Decision 3 of');
    },
  },
  Review: {
    async open(page, app, first) {
      await go(page, app, '#/');
      await go(page, app, '#/review/1');
      const moments = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
      const start = page.getByRole('button', { name: 'Start the Review' });
      await expect(start.or(moments.first())).toBeVisible();
      if (first && (await start.isVisible())) await start.click();
      await expect(moments.first()).toBeVisible({ timeout: 90_000 });
      await coachIdle(page);
    },
    shown: (page) => [page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first().getByRole('button', { name: /^Show moment/ })],
    async tapButton(page, least) {
      const show = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first().getByRole('button', { name: /^Show moment/ });
      const was = await show.getAttribute('aria-expanded');
      await record(page);
      const from = (await geo(page)).sheetTop;
      await tap(page, show);
      await expect(show).toHaveAttribute('aria-expanded', was === 'true' ? 'false' : 'true');
      if (was !== 'true') {
        // Opening a moment pulls the sheet up for it: by the same spring.
        const g = await expectUp(page);
        await expectAnimated(page, from, g.sheetTop, least);
      }
    },
  },
  Puzzles: {
    async open(page, app, first) {
      if (first) await go(page, app, '#/puzzles/italian-game');
      else await page.getByRole('button', { name: 'Next Puzzle' }).click();
      await expect(page.getByRole('region', { name: 'Puzzle' })).toContainText(/Find the best move for (White|Black)\./);
    },
    shown: (page) => [page.getByRole('button', { name: 'Show the solution' })],
    async tapButton(page) {
      await tap(page, page.getByRole('button', { name: 'Show the solution' }));
      await expect(page.getByText('Here is the solution.')).toBeVisible();
      // The Coach comes into the sheet now: docked at the foot of the screen with the sheet at rest.
      await expect(page.getByRole('textbox', { name: 'Your Why Question' })).toBeInViewport({ ratio: 1 });
      await expectRest(page);
    },
  },
  'Engine Game': {
    async open(page, app, first) {
      const status = page.getByRole('status', { name: 'Game status' });
      if (first) {
        await go(page, app, '#/engine-game');
        await page.getByRole('radio', { name: 'White' }).check();
        await page.getByRole('radio', { name: 'Beginner' }).check();
        await page.getByRole('button', { name: 'Start the Engine Game' }).click();
        await expect(status).toContainText('Your move');
        await play(page, 'e2e4', 'Engine Game board');
        await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
        await expect(status).toContainText('Your move');
        await coachIdle(page);
      }
      await toRest(page);
      // Ba6 gives the bishop away: a Blunder, and the choice to take it back.
      await play(page, 'f1a6', 'Engine Game board');
      await expect(status).toContainText('Take the move back, or carry on?');
      await coachIdle(page);
    },
    shown: (page) => [page.getByRole('button', { name: 'Take the move back' }), page.getByRole('button', { name: 'Carry on' })],
    async tapButton(page) {
      await tap(page, page.getByRole('button', { name: 'Take the move back' }));
      await expect(page.getByRole('status', { name: 'Game status' })).toContainText('Your move');
      await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
    },
  },
  Board: {
    async open(page, app, first) {
      if (first) {
        await go(page, app, '#/board');
        await play(page, 'e2e4');
        await play(page, 'e7e5');
        await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
      }
      await toRest(page);
    },
    shown: (page) => [page.getByRole('button', { name: 'Show Engine lines' })],
    async tapButton(page) {
      // The move list is under the Ask box at rest, as it is today: up, its moves take taps.
      await tap(page, handle(page));
      await expectUp(page);
      const fen = page.locator('.board[role="group"]');
      await tap(page, page.getByRole('button', { name: /^Move 1\.? e4/ }));
      await expect(fen).toHaveAttribute('data-fen', /^rnbqkbnr\/pppppppp\/8\/8\/4P3\//);
      await tap(page, page.getByRole('button', { name: /^Move 1\S* e5/ }));
      await expect(fen).toHaveAttribute('data-fen', /^rnbqkbnr\/pppp1ppp\/8\/4p3\/4P3\//);
    },
  },
};

/** Issue 80's journeys on one screen at one size, the sheet at rest to start with. */
async function journeys(kind: Kind, page: Page, finger: Finger, screen: Screen, label: string): Promise<void> {
  const width = page.viewportSize()!.width;
  const x = Math.round(width * 0.3);
  // Headless WebKit on Linux renders in software, 40 to 350 ms a frame even on its own: it can't
  // show the frames of a move, only that it ends where it should without a bounce. Chromium can.
  const least = kind === 'webkit' ? 0 : 5;
  const rest = await expectRest(page);
  const board = rest.board;

  // At rest the sheet shows what the screen needs, clear of the Ask box: no scrolling to reach it.
  for (const b of screen.shown(page)) await expectShownAtRest(page, b);

  // A 90 px drag up on the resting sheet: it follows the finger frame by frame, the content doesn't
  // scroll and the board doesn't move or shrink; let go, it settles up, animated.
  let frames = await drag(page, finger, x, Math.round(rest.sheetTop + 30), -90, 10, 16, false);
  expectFollowed(frames, 8);
  // (The Review scrolls its own panel to show the current moment: the finger never scrolls it.)
  expect(frames.every((f) => f.scrollTop === rest.scrollTop && f.board === board), `${label}: scroll and board ${JSON.stringify(frames)}`).toBe(true);
  // A bit of dim already, as the sheet comes up over the board.
  expect((await geo(page)).dim).toBeGreaterThan(0);
  const before = (await geo(page)).sheetTop;
  await record(page);
  await finger.up();
  let up = await expectUp(page);
  await expectAnimated(page, before, up.sheetTop, least);
  expect(up.board).toBe(board);
  expect(up.scrollTop).toBe(rest.scrollTop);

  // Up, at least the top half of the board shows above the sheet: a touch there is the dim's (a tap
  // brings the board back, a pull peeks). The rest of it is under the sheet: every point of it is the
  // sheet's, so no touch reaches a square.
  const hits = await page.evaluate(({ band, top, bottom }) => {
    const out = { band: 0, covered: 0, points: 0 };
    for (const fx of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      const px = innerWidth * fx;
      if (document.elementFromPoint(px, band)?.classList.contains('v3-scrim')) out.band++;
      for (let py = top; py < bottom; py += 40) {
        out.points++;
        if (document.elementFromPoint(px, py)?.closest('.side.panel')) out.covered++;
      }
    }
    return out;
  }, { band: (up.colTop + up.sheetTop) / 2, top: up.sheetTop + 2, bottom: up.colBottom - 1 });
  expect(hits.band).toBe(5);
  expect(hits.covered).toBe(hits.points);
  // A real tap on the covered board, where the sheet has nothing to press there: the board doesn't move.
  const quiet = await page.evaluate(({ top, bottom }) => {
    for (let py = bottom - 8; py > top; py -= 12) {
      for (const px of [6, innerWidth - 6]) {
        const el = document.elementFromPoint(px, py);
        if (el?.closest('.side.panel') && !el.closest('button, a, input, textarea, select, summary, label, [role="tab"], [tabindex]')) return { x: px, y: py };
      }
    }
    return null;
  }, { top: up.sheetTop + 20, bottom: up.colBottom });
  if (quiet) {
    const fenBefore = await page.locator('.board[role="group"]').getAttribute('data-fen');
    await tapAt(page, quiet.x, quiet.y);
    await page.waitForTimeout(200);
    await expect(page.locator('.board[role="group"]')).toHaveAttribute('data-fen', fenBefore ?? '');
    await expectUp(page);
  }

  // Up, a drag in the content scrolls it (where it has more to show); then a drag down from the
  // content's top lowers the sheet, following the finger, and a scroll that reaches the top hands
  // over to the sheet without a jump.
  up = await geo(page);
  const bodyY = Math.round(up.sheetTop + 60);
  const scroller = up.room > 4 ? 'body' : up.logRoom > 4 ? 'log' : null;
  if (scroller) {
    const sy = scroller === 'body' ? bodyY : Math.round(up.coachTop + 20);
    const read = () => page.evaluate((s) => document.querySelector<HTMLElement>(s === 'body' ? '.panel-body' : '.coach .log')!.scrollTop, scroller);
    const s0 = await read();
    frames = await drag(page, finger, x, sy, -60, 6);
    await page.waitForTimeout(300);
    if (kind === 'chromium') {
      expect(await read(), `${label}: the ${scroller} scrolled`).toBeGreaterThan(s0 + 20);
    } else {
      // Synthetic touches can't scroll WebKit: the sheet left every move to the browser.
      expect(frames.every((f) => !f.prevented), `${label}: moves left to the browser`).toBe(true);
    }
    // The sheet didn't move.
    expect((await geo(page)).sheetTop).toBeCloseTo(up.sheetTop, 0);
    if (kind === 'chromium' && scroller === 'body') {
      // Scrolled part-way (40 px, whatever the fling did), a long drag down scrolls back to the top,
      // then the sheet follows the rest of it.
      await page.evaluate(() => (document.querySelector<HTMLElement>('.panel-body')!.scrollTop = 40));
      frames = await drag(page, finger, x, bodyY, 200, 20, 16, false);
      const last = frames.at(-1)!;
      expect(last.scrollTop, `${label}: back at the top`).toBe(0);
      expect(last.sheetTop, `${label}: then the sheet followed`).toBeGreaterThan(up.sheetTop + 40);
      // From the hand-off on, the sheet keeps the same distance from the finger: no jump. (During a
      // native scroll Chromium may deliver two moves as one, so allow one step of 10 px.)
      const from = frames.findIndex((f) => f.sheetTop > up.sheetTop + 0.5);
      const offsets = frames.slice(from).map((f) => f.sheetTop - f.finger);
      expect(Math.max(...offsets) - Math.min(...offsets), `${label}: ${JSON.stringify(frames)}`).toBeLessThanOrEqual(10.5);
      await finger.up();
      await expectRest(page);
      await tap(page, handle(page));
      up = await expectUp(page);
    } else {
      await page.evaluate((s) => (document.querySelector<HTMLElement>(s === 'body' ? '.panel-body' : '.coach .log')!.scrollTop = 0), scroller);
    }
  }
  // A drag down that starts with the content at its top lowers the sheet with the finger.
  frames = await drag(page, finger, x, bodyY, 120, 12, 16, false);
  expectFollowed(frames, 10);
  expect(frames.every((f) => f.board === board)).toBe(true);
  const low = (await geo(page)).sheetTop;
  await record(page);
  await finger.up();
  const down = await expectRest(page);
  await expectAnimated(page, low, down.colBottom, least);

  // A short fast flick up (under 80 px) raises the sheet; a slow 40 px drag returns it to rest.
  await flick(page, finger, x, Math.round(down.sheetTop + 30), -50);
  await expectUp(page);
  await tap(page, handle(page));
  await expectRest(page);
  await drag(page, finger, x, Math.round(down.sheetTop + 30), -40, 8, 50);
  await expectRest(page);

  // A change of direction in one drag: up 120, then back down 80 at speed. It follows both ways,
  // then goes where it was heading: down.
  const y0 = Math.round(down.sheetTop + 30);
  await finger.down(x, y0);
  const path = [...Array.from({ length: 8 }, (_, i) => y0 - 15 * (i + 1)), ...Array.from({ length: 4 }, (_, i) => y0 - 120 + 20 * (i + 1))];
  const tops: { finger: number; sheetTop: number }[] = [];
  for (const fy of path) {
    await page.waitForTimeout(16);
    await finger.move(x, fy);
    await frame(page);
    await frame(page);
    tops.push({ finger: fy, sheetTop: (await geo(page)).sheetTop });
  }
  expectFollowed(tops.slice(7), 4);
  expect(Math.min(...tops.map((t) => t.sheetTop))).toBeLessThan(down.sheetTop - 80);
  await finger.up();
  await expectRest(page);

  // The handle: a tap toggles, animated both ways.
  await record(page);
  await tap(page, handle(page));
  up = await expectUp(page);
  await expectAnimated(page, down.sheetTop, up.sheetTop, least);
  // The band of the board: a tap brings the board back, animated.
  await record(page);
  await tapAt(page, x, (up.colTop + up.sheetTop) / 2);
  await expectRest(page);
  await expectAnimated(page, up.sheetTop, down.colBottom, least);
  await tap(page, handle(page));
  await expectUp(page);
  await tap(page, handle(page));
  await expectRest(page);

  // A touch that starts on the Ask box (or any box to type in) never moves the sheet.
  const box = page.getByRole('textbox', { name: 'Your Why Question' });
  if (await box.isVisible()) {
    const b = (await box.boundingBox())!;
    frames = await drag(page, finger, Math.round(b.x + 20), Math.round(b.y + b.height / 2), -90, 9);
    expect(frames.every((f) => Math.abs(f.sheetTop - down.sheetTop) < 0.5), `${label}: the Ask box ${down.sheetTop} ${JSON.stringify(frames)}`).toBe(true);
    await expectRest(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expectRest(page);
  }

  // A tap on a button in the sheet still does its job.
  await screen.tapButton(page, least);
}

for (const kind of ['chromium', 'webkit'] as const) {
  test.describe(`Version 3 of the phone's sheet in ${kind === 'chromium' ? 'Chromium, with real touches' : 'WebKit, with synthetic touches'}`, () => {
    for (const [name, screen] of Object.entries(SCREENS)) {
      test(`${name}: the sheet slides over the board with the finger at 390×664, 402×714, 440×790 and 390×844`, async ({ browser, playwright, app }) => {
        test.setTimeout(480_000);
        const b = kind === 'chromium' ? browser : await playwright.webkit.launch();
        try {
          const { page, finger, context } = await phone(kind, b, app);
          for (const [i, size] of SIZES.entries()) {
            await page.setViewportSize({ width: size[0], height: size[1] });
            await screen.open(page, app, i === 0);
            await journeys(kind, page, finger, screen, `${name} ${size[0]}×${size[1]}`);
          }
          await context.close();
        } finally {
          if (b !== browser) await b.close();
        }
      });
    }
  });
}

test('Version 3: with the keyboard up for the Ask box, the sheet comes up, and a drag down closes the keyboard and lets it down', async ({ browser, app }) => {
  const { page, finger } = await phone('chromium', browser, app);
  await SCREENS.Board!.open(page, app, true);
  await expectRest(page);
  const box = page.getByRole('textbox', { name: 'Your Why Question' });
  await tap(page, box);
  await expect(box).toBeFocused();
  const up = await expectUp(page);
  // The board stays where it was, full size, under the sheet.
  expect(up.board).toBe((await geo(page)).board);
  await drag(page, finger, 120, Math.round(up.sheetTop + 40), 100, 10);
  await expect(box).not.toBeFocused();
  await expectRest(page);
});

test('Version 3: a drag that starts on a button moves the sheet and doesn’t press the button', async ({ browser, app }) => {
  const { page, finger, context } = await phone('chromium', browser, app);
  await SCREENS.Lesson!.open(page, app, true);
  await expectRest(page);
  const b = (await page.getByRole('button', { name: 'Continue' }).boundingBox())!;
  const frames = await drag(page, finger, Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2), -120, 10);
  expectFollowed(frames, 7);
  await expectUp(page);
  // Still the same decision: Continue wasn't pressed.
  await page.waitForTimeout(300);
  await expect(page.locator('.head-line')).toContainText('Decision 2 of');
  await context.close();
});

/** Per frame, from now for `ms`: the sheet's top, the Coach's visible top, the frame's time and the state the app sees. */
async function watch(page: Page, ms = 900): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as unknown as { __w: { dt: number; sheet: number; coach: number; full: boolean }[] };
    w.__w = [];
    const side = document.querySelector<HTMLElement>('.side.panel')!;
    const t0 = performance.now();
    let last = t0;
    const tick = (now: number) => {
      w.__w.push({
        dt: now - last,
        sheet: side.getBoundingClientRect().top,
        coach: side.querySelector<HTMLElement>(':scope > .coach')!.getBoundingClientRect().top,
        full: document.querySelector('.board-screen')!.classList.contains('sheet-full'),
      });
      last = now;
      if (now - t0 < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

async function watched(page: Page): Promise<{ dt: number; sheet: number; coach: number; full: boolean }[]> {
  await page.waitForTimeout(1000);
  return page.evaluate(() => (window as unknown as { __w: { dt: number; sheet: number; coach: number; full: boolean }[] }).__w);
}

/** The Coach's box and log: their laid-out heights, which no move of the sheet may change. */
const coachSize = (page: Page) =>
  page.evaluate(() => {
    const coach = document.querySelector<HTMLElement>('.side.panel > .coach')!;
    return { coach: coach.offsetHeight, log: coach.querySelector<HTMLElement>('.log')!.offsetHeight };
  });

test('Version 3: the Coach never changes size; its first lines at rest grow into its whole reply with the sheet, frame by frame', async ({ browser, app }) => {
  const { page, finger, context } = await phone('chromium', browser, app);
  await SCREENS.Lesson!.open(page, app, true);
  const rest = await expectRest(page);
  const size = await coachSize(page);
  // A long reply: the log is much taller than its two lines at rest.
  expect(size.log).toBeGreaterThan(80);
  // At rest the Coach shows its first lines above the Ask row, as today's sheet does, and Continue above it.
  expect(rest.layoutBottom - rest.coachTop).toBeLessThan(size.coach - 40);
  await expectShownAtRest(page, page.getByRole('button', { name: 'Continue' }));

  const check = (frames: { dt: number; coach: number }[], label: string) => {
    for (let i = 2; i < frames.length; i++) {
      // The Coach's top edge moves with the sheet, never by a one-frame jump of its size.
      if (Math.max(frames[i]!.dt, frames[i - 1]!.dt) < 20) {
        expect(Math.abs(frames[i]!.coach - frames[i - 1]!.coach), `${label}: ${frames.map((f) => f.coach.toFixed(0)).join(' ')}`).toBeLessThan(40);
      }
    }
  };
  // Released after a drag up.
  await drag(page, finger, 120, Math.round(rest.sheetTop + 30), -90, 10, 16, false);
  await watch(page);
  await finger.up();
  check(await watched(page), 'release');
  await expectUp(page);
  expect(await coachSize(page)).toEqual(size);
  // A tap on the handle, down and up.
  for (const label of ['tap down', 'tap up']) {
    await watch(page);
    await tap(page, handle(page));
    check(await watched(page), label);
    expect(await coachSize(page)).toEqual(size);
  }
  await expectUp(page);
  await context.close();
});

test('Version 3: the app hears of a move only once the sheet has settled, never on the frame it starts', async ({ browser, app }) => {
  const { page, finger, context } = await phone('chromium', browser, app);
  await SCREENS.Lesson!.open(page, app, true);
  const rest = await expectRest(page);
  const settledFirst = (frames: { sheet: number; full: boolean }[], target: number, full: boolean) => {
    const flipped = frames.findIndex((f) => f.full === full);
    const trace = JSON.stringify(frames.map((f) => [Math.round(f.sheet), f.full]));
    expect(flipped, trace).toBeGreaterThan(2);
    // The sheet moved first, and arrived, before the app re-rendered for its new state.
    expect(frames.slice(0, flipped).some((f) => Math.abs(f.sheet - target) > 20), trace).toBe(true);
    expect(Math.abs(frames[flipped - 1]!.sheet - target), trace).toBeLessThan(0.6);
  };
  await watch(page);
  await tap(page, handle(page));
  let frames = await watched(page);
  const up = await expectUp(page);
  settledFirst(frames, up.sheetTop, true);
  await watch(page);
  await tap(page, handle(page));
  frames = await watched(page);
  await expectRest(page);
  settledFirst(frames, rest.sheetTop, false);
  // A drag's release too.
  await drag(page, finger, 120, Math.round(rest.sheetTop + 30), -90, 10, 16, false);
  await watch(page);
  await finger.up();
  frames = await watched(page);
  await expectUp(page);
  settledFirst(frames, up.sheetTop, true);
  await context.close();
});

test('Version 3: up, a pull down on the board peeks at all of it and springs back, the text where it was', async ({ browser, app }) => {
  const { page, finger, context } = await phone('chromium', browser, app);
  await SCREENS.Review!.open(page, app, true);
  await tap(page, handle(page));
  const up = await expectUp(page);
  // Reading on: the moments scrolled a little.
  await page.evaluate(() => (document.querySelector<HTMLElement>('.panel-body')!.scrollTop += 60));
  const scrolled = (await geo(page)).scrollTop;
  expect(scrolled).toBeGreaterThan(0);
  // A pull down from the board above the sheet: the sheet follows the finger and the whole board shows.
  const y0 = Math.round((up.colTop + up.sheetTop) / 2);
  const frames = await drag(page, finger, 150, y0, Math.round(up.colBottom - up.sheetTop + 30), 14, 16, false);
  expectFollowed(frames.slice(0, 10), 7);
  const peek = await geo(page);
  expect(peek.sheetTop).toBeGreaterThanOrEqual(peek.colBottom - 1);
  expect(peek.board).toBe(up.board);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
  // Let go: back up, animated, the text where it was.
  await record(page);
  await finger.up();
  const back = await expectUp(page);
  await expectAnimated(page, peek.sheetTop, up.sheetTop, 5);
  expect(back.scrollTop).toBe(scrolled);
  // A tap on the board above the sheet still brings the board back.
  await tapAt(page, 150, y0);
  await expectRest(page);
  await context.close();
});

test('Version 3: taps on the handle in quick succession, or just as the sheet settles, always end where the last one sends it', async ({ browser, app }) => {
  const { page, context } = await phone('chromium', browser, app);
  await SCREENS.Board!.open(page, app, true);
  await expectRest(page);
  // A double tap at a person's pace (150 ms apart): up, then straight back down.
  await tap(page, handle(page));
  await page.waitForTimeout(150);
  await tap(page, handle(page));
  await expectRest(page);
  // A tap at every moment around the end of the spring (it settles in about 400 ms) and its commit.
  for (const ms of [330, 380, 420, 460, 520]) {
    await tap(page, handle(page));
    await page.waitForTimeout(ms);
    await tap(page, handle(page));
    await expectRest(page);
  }
  await context.close();
});

test('Version 3: a tap on the board while the sheet is still on its way up moves no piece and brings the board back', async ({ browser, app }) => {
  const { page, context } = await phone('chromium', browser, app);
  await go(page, app, '#/board');
  await play(page, 'e2e4');
  await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(1);
  const rest = await expectRest(page);
  const fen = await page.locator('.board[role="group"]').getAttribute('data-fen');
  const centre = async (sq: string) => {
    const b = (await page.getByRole('button', { name: new RegExp(`^${sq},`) }).boundingBox())!;
    return [b.x + b.width / 2, b.y + b.height / 2] as const;
  };
  // Black to move. The handle, then at once a tap on the pawn on d7, near the board's top, as if to move it.
  await tap(page, handle(page));
  await page.waitForTimeout(60);
  await tapAt(page, ...(await centre('d7')));
  await expectRest(page);
  // Had d7 been picked up, this tap would play d5: it doesn't.
  await tapAt(page, ...(await centre('d5')));
  await page.waitForTimeout(300);
  await expect(page.locator('.board[role="group"]')).toHaveAttribute('data-fen', fen ?? '');
  expect((await geo(page)).board).toBe(rest.board);
  await context.close();
});

test('Version 3: with less motion asked for, the sheet still follows the finger but settles at once', async ({ browser, app }) => {
  const { page, finger, context } = await phone('chromium', browser, app);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await SCREENS.Board!.open(page, app, true);
  const rest = await expectRest(page);
  const frames = await drag(page, finger, 120, Math.round(rest.sheetTop + 30), -90, 10, 16, false);
  expectFollowed(frames, 8);
  await finger.up();
  await frame(page);
  await frame(page);
  let g = await geo(page);
  expect(g.sheetTop).toBeCloseTo(g.colTop + g.band + g.upAt, 0);
  await handle(page).click();
  await frame(page);
  g = await geo(page);
  expect(g.sheetTop).toBeCloseTo(g.colBottom, 0);
  await context.close();
});

test('Version 3: a second finger doesn’t take the sheet from the first, and a two-finger touch moves nothing', async ({ browser, app }) => {
  const { page, context } = await phone('chromium', browser, app);
  await SCREENS.Board!.open(page, app, true);
  const rest = await expectRest(page);
  const cdp = await context.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
  const y0 = Math.round(rest.sheetTop + 30);
  await touch('touchStart', [{ x: 100, y: y0, id: 1 }]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: 100, y: y0 - i * 12, id: 1 }]);
  await frame(page);
  const mid = (await geo(page)).sheetTop;
  // A second finger lands and moves the other way: the sheet keeps following the first.
  await touch('touchStart', [{ x: 100, y: y0 - 60, id: 1 }, { x: 300, y: y0 - 100, id: 2 }]);
  for (let i = 1; i <= 4; i++) await touch('touchMove', [{ x: 100, y: y0 - 60 - i * 10, id: 1 }, { x: 300, y: y0 - 100 + i * 30, id: 2 }]);
  await frame(page);
  expect((await geo(page)).sheetTop).toBeCloseTo(mid - 40, 0);
  await touch('touchEnd', []);
  await expectUp(page);
  // Two fingers down at once: a pinch, not the sheet's.
  await tap(page, handle(page));
  const before = (await expectRest(page)).sheetTop;
  await touch('touchStart', [{ x: 100, y: y0, id: 1 }, { x: 250, y: y0, id: 2 }]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: 100, y: y0 - i * 15, id: 1 }, { x: 250, y: y0 - i * 15, id: 2 }]);
  await frame(page);
  await frame(page);
  expect((await geo(page)).sheetTop).toBeCloseTo(before, 0);
  await touch('touchEnd', []);
  await expectRest(page);
  await context.close();
});

test('Version 3 leaves the desktop as it is: the panel beside the board, nothing moved or dimmed', async ({ page, app }) => {
  const boxes = async (n: number) => {
    await page.goto(`${app.url}/?sheet=${n}#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/?sheet=${n}#/board`);
    await expect(page.locator('.board[role="group"]')).toBeVisible();
    return page.evaluate(() => {
      const r = (s: string) => JSON.stringify(document.querySelector(s)!.getBoundingClientRect());
      const side = document.querySelector<HTMLElement>('.side.panel')!;
      return { board: r('.board-col'), panel: r('.side.panel'), coach: r('.side.panel > .coach'), transform: side.style.transform, scrim: document.querySelector('.v3-scrim') ? getComputedStyle(document.querySelector('.v3-scrim')!).display : 'none' };
    });
  };
  const today = await boxes(0);
  const v3 = await boxes(3);
  expect(v3).toEqual(today);
  expect(v3.transform).toBe('');
  expect(v3.scrim).toBe('none');
});
