// PROTOTYPE (#80): Version 2 of the phone's panel sheet (lib/sheet-variants/v2.ts), every page with
// `?sheet=2`. The sheet's motion is the browser's own scrolling: these journeys prove #80's Done means
// on the Lesson, the Review, Puzzles, the Engine Game and the Board at four iPhone sizes.
//
// In Chromium the finger is real: CDP touch events, which the browser turns into its own scrolling,
// snapping and momentum. WebKit on Linux has no touch input that scrolls, so there the finger is
// synthetic TouchEvents and the test scrolls the sheet by the finger's travel, as the browser would.
// That proves the driver's side in WebKit (the release, the smooth moves, the board following the
// scroll, the taps), not iOS's own touch handling, momentum or rubber-banding.
import { type Browser, type BrowserContext, type Locator, type Page, webkit } from '@playwright/test';
import { expect, play, test, type AppFixture } from '../fixtures/app.ts';

const SIZES = [
  [390, 664],
  [402, 714],
  [440, 790],
  [390, 844],
] as const;

type Screen = 'lesson' | 'review' | 'puzzles' | 'engine' | 'board';
const SCREENS: Screen[] = ['lesson', 'review', 'puzzles', 'engine', 'board'];

/** A finger on the screen: a drag of `dy` px (negative is up) in `steps` moves, or a tap. */
interface Finger {
  drag(x: number, y: number, dy: number, opts?: { steps?: number; stepMs?: number; onMove?: () => Promise<void> }): Promise<void>;
  tap(x: number, y: number): Promise<void>;
}

/** Chromium's own touch input, which scrolls, snaps and flings as on a phone. */
async function realFinger(page: Page): Promise<Finger> {
  const cdp = await page.context().newCDPSession(page);
  // Each event carries the time the finger was there, so a flick stays a flick however slowly the
  // test machine sends it.
  let clock = 0;
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }], timestamp: clock });
  return {
    async drag(x, y, dy, { steps = 10, stepMs = 16, onMove } = {}) {
      clock = Date.now() / 1000;
      await send('touchStart', x, y);
      for (let i = 1; i <= steps; i++) {
        clock += stepMs / 1000;
        await send('touchMove', x, y + (dy * i) / steps);
        await page.waitForTimeout(stepMs);
        await onMove?.();
      }
      clock += 0.008;
      await send('touchEnd');
    },
    async tap(x, y) {
      clock = Date.now() / 1000;
      await send('touchStart', x, y);
      clock += 0.05;
      await send('touchEnd');
    },
  };
}

/** iOS starts a scroll only after about 10 pt of travel (its pan hysteresis), and sends every move. */
const IOS_SLOP = 10;

/**
 * Synthetic TouchEvents, for WebKit on Linux, the way iOS delivers a drag: every move reaches the
 * page, and the test scrolls what the browser would (the nearest scroller that can go that way,
 * unless `touch-action: none` or a listener stops it) once the finger is past iOS's slop, by the
 * finger's further moves. It leaves the release to the page and the browser. No momentum: a flick
 * ends where the finger lifts.
 */
function syntheticFinger(page: Page): Finger {
  return {
    async drag(x, y, dy, { steps = 10, stepMs = 16, onMove } = {}) {
      await page.evaluate(
        ({ x, y }) => {
          const target = document.elementFromPoint(x, y)!;
          const w = window as unknown as Record<string, unknown>;
          const make = (type: string, cy: number, ended: boolean) => {
            const t = { identifier: 1, target, clientX: x, clientY: cy, pageX: x, pageY: cy, screenX: x, screenY: cy };
            const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
            Object.defineProperty(ev, 'touches', { value: ended ? [] : [t] });
            Object.defineProperty(ev, 'targetTouches', { value: ended ? [] : [t] });
            Object.defineProperty(ev, 'changedTouches', { value: [t] });
            // The time the finger was there, as a phone stamps it, however slowly the test sends it.
            Object.defineProperty(ev, 'timeStamp', { value: (window as unknown as { __clock: number }).__clock });
            return ev;
          };
          (window as unknown as { __clock: number }).__clock = performance.now();
          let blocked = false;
          for (let n: Element | null = target; n; n = n.parentElement) if (getComputedStyle(n).touchAction === 'none') blocked = true;
          w.__finger = { target, make, lastY: y, startY: y, blocked };
          target.dispatchEvent(make('touchstart', y, false));
        },
        { x, y },
      );
      for (let i = 1; i <= steps; i++) {
        await page.evaluate(({ cy, stepMs, slop }) => {
          const f = (window as unknown as { __finger: { target: Element; make: (t: string, y: number, e: boolean) => Event; lastY: number; startY: number; blocked: boolean } }).__finger;
          (window as unknown as { __clock: number }).__clock += stepMs;
          const ev = f.make('touchmove', cy, false);
          f.target.dispatchEvent(ev);
          // Nothing inside the slop; past it, the finger's further moves.
          const before = Math.abs(f.lastY - f.startY);
          const now = Math.abs(cy - f.startY);
          let by = now <= slop ? 0 : Math.sign(f.lastY - cy) * (now - Math.max(before, slop));
          if (!ev.defaultPrevented && !f.blocked) {
            for (let n: HTMLElement | null = f.target as HTMLElement; n && by; n = n.parentElement) {
              if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
              const before = n.scrollTop;
              n.scrollTop = before + by;
              by -= n.scrollTop - before;
            }
          }
          f.lastY = cy;
        }, { cy: y + (dy * i) / steps, stepMs, slop: IOS_SLOP });
        await page.waitForTimeout(stepMs);
        await onMove?.();
      }
      await page.evaluate(() => {
        const f = (window as unknown as { __finger: { target: Element; make: (t: string, y: number, e: boolean) => Event; lastY: number } }).__finger;
        (window as unknown as { __clock: number }).__clock += 8;
        f.target.dispatchEvent(f.make('touchend', f.lastY, true));
      });
    },
    async tap(x, y) {
      await page.touchscreen.tap(x, y);
    },
  };
}

/** The sheet as drawn: the handle's top, the scroll, the content's offset under the handle, the board's width. */
function measure(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('.side.panel')!;
    const body = sheet.querySelector<HTMLElement>(':scope > .panel-body')!;
    const handle = sheet.querySelector<HTMLElement>(':scope > .sheet-handle')!;
    const top = handle.getBoundingClientRect().top;
    // The content's first part that scrolls with it (the Review's tabs stick under the handle).
    const first = [...body.children].find((c) => c.getBoundingClientRect().height > 0 && getComputedStyle(c).position !== 'sticky') ?? body;
    return {
      top,
      scroll: sheet.scrollTop,
      max: sheet.scrollHeight - sheet.clientHeight,
      d: parseFloat(getComputedStyle(document.querySelector('.board-layout')!).getPropertyValue('--v2-d')),
      offset: first.getBoundingClientRect().top - top,
      bodyScroll: body.scrollTop,
      board: document.querySelector('.board')!.getBoundingClientRect().width,
      up: handle.getAttribute('aria-expanded') === 'true',
    };
  });
}
type Measure = Awaited<ReturnType<typeof measure>>;

/** A frame: when it was drawn and the sheet's scroll in it. */
/** A frame: when it was drawn, the sheet's scroll in it, and the Coach's top as drawn (its clip at rest included). */
type Frame = { t: number; s: number; c: number };

/** The sheet's scroll on every frame while `act` runs and for `ms` after: whether a move was animated. */
async function frames(page: Page, act: () => Promise<void>, ms = 700): Promise<Frame[]> {
  await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('.side.panel')!;
    const w = window as unknown as { __frames: Frame[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    const tick = (t: number) => {
      const coach = sheet.querySelector<HTMLElement>(':scope > .coach');
      const clip = coach ? /inset\(([\d.]+)px/.exec(getComputedStyle(coach).clipPath)?.[1] : undefined;
      const c = coach ? coach.getBoundingClientRect().top + (clip ? parseFloat(clip) : 0) : 0;
      w.__frames.push({ t, s: Math.round(sheet.scrollTop), c: Math.round(c) });
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
}

/**
 * A move from `from` to `to` that was animated, not a jump: it was drawn on the way, or (on a
 * loaded machine that draws few frames) took a smooth scroll's time to arrive.
 */
function expectAnimated(track: Frame[], from: number, to: number, what: string): void {
  const near = (f: Frame, v: number) => Math.abs(f.s - v) <= 2;
  const leave = track.findLastIndex((f) => near(f, from));
  const arrive = track.findIndex((f, i) => i > leave && near(f, to));
  const shown = track.map((f) => f.s).join(' ');
  expect(leave, `${what}: starts at ${from} (${shown})`).toBeGreaterThanOrEqual(0);
  expect(arrive, `${what}: arrives at ${to} (${shown})`).toBeGreaterThan(leave);
  const between = arrive - leave - 1;
  const took = track[arrive]!.t - track[leave]!.t;
  expect(between >= 2 || (between >= 1 && took >= 60) || took >= 120, `${what}: ${between} frames on the way in ${Math.round(took)} ms (${shown})`).toBe(true);
  // Within a pixel or two: the layout's fractions.
  expect(Math.abs(track.at(-1)!.s - to), `${what} ends at ${to}: ${shown}`).toBeLessThanOrEqual(2);
  // The Coach grows and shrinks with the scroll: its top as drawn never jumps.
  const steps = track.slice(1).map((f, i) => Math.abs(f.c - track[i]!.c));
  expect(Math.max(0, ...steps), `${what}: the Coach's top as drawn moves with the sheet (${track.map((f) => f.c).join(' ')})`).toBeLessThanOrEqual(30);
}

const handle = (page: Page) => page.getByRole('button', { name: /^(Pull the panel up|Let the panel down)$/ });

async function settled(page: Page): Promise<Measure> {
  let last = await measure(page);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(60);
    const now = await measure(page);
    if (Math.abs(now.scroll - last.scroll) < 0.5 && now.up === (now.scroll > now.d / 2)) return now;
    last = now;
  }
  return last;
}

async function tapOn(page: Page, finger: Finger, selector: string): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** Opens a screen as a Player gets to it, with the sheet's content in place. */
async function open(page: Page, url: string, screen: Screen): Promise<void> {
  const base = `${url}/?sheet=2`;
  if (screen === 'lesson') {
    await page.goto(`${base}#/lesson/italian-game`);
    await page.getByRole('button', { name: /^(Start from the beginning|Start the Lesson)$/ }).last().click();
    await play(page, 'e2e4', 'Italian Game Lesson board');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  } else if (screen === 'review') {
    await page.goto(`${base}#/review/1`);
    const start = page.getByRole('button', { name: 'Start the Review' });
    const moment = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first();
    // The Engine analyses the game first: slow on a loaded machine.
    await expect(start.or(moment)).toBeVisible({ timeout: 180_000 });
    if (await start.isVisible()) await start.click();
    await expect(moment).toBeVisible({ timeout: 180_000 });
    // Starting the Review opens its first key moment for the Player, which pulls the sheet up (as
    // today's does): the journey starts from rest.
    await page.waitForTimeout(1500);
    if ((await handle(page).getAttribute('aria-expanded')) === 'true') {
      await handle(page).click();
      await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
      await page.waitForTimeout(500);
    }
  } else if (screen === 'puzzles') {
    await page.goto(`${base}#/puzzles/italian-game`);
    // The solution shown, so the Coach and its Ask box are docked (a Puzzle already given up shows it).
    const show = page.getByRole('button', { name: 'Show the solution' });
    const ask = page.getByRole('textbox', { name: 'Your Why Question' });
    await expect(show.or(ask)).toBeVisible();
    // Under the resting sheet's fold on the shortest phones: a click as the app gets it, without
    // the scroll into view that Playwright's own click makes first (which would pull the sheet up).
    if (await show.isVisible()) await show.dispatchEvent('click');
    await expect(ask).toBeVisible();
  } else if (screen === 'engine') {
    await page.goto(`${base}#/engine-game`);
    await page.getByRole('radio', { name: 'White' }).check();
    await page.getByRole('radio', { name: 'Beginner' }).check();
    await page.getByRole('button', { name: 'Start the Engine Game' }).click();
    const status = page.getByRole('status', { name: 'Game status' });
    await expect(status).toContainText('Your move');
    await play(page, 'e2e4', 'Engine Game board');
    await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
    await expect(status).toContainText('Your move');
  } else {
    await page.goto(`${base}#/board`);
    await play(page, 'e2e4');
  }
  await expect(handle(page), `${screen} ${page.viewportSize()?.width}×${page.viewportSize()?.height} opens at rest`).toHaveAttribute('aria-expanded', 'false');
  // The driver has laid the sheet out.
  await expect.poll(async () => (await measure(page)).d).toBeGreaterThan(60);
  await page.waitForTimeout(300);
}

/** #80's Done means, on one screen at one size. */
async function journey(page: Page, finger: Finger, screen: Screen, width: number, label: string): Promise<{ contentScrolled: boolean }> {
  const at = `${label} ${screen} ${width}×${page.viewportSize()!.height}`;
  const rest = await measure(page);
  expect(rest.scroll, at).toBe(0);
  const x = width / 2;
  /** A point on the sheet's content, just under the handle. */
  const onSheet = async () => (await measure(page)).top + 34;

  // The board takes its own touches at rest: it is drawn above the scroller, which lets nothing pass
  // through (no `pointer-events: none` anywhere in the frame).
  const layering = await page.evaluate(() => {
    const board = document.querySelector('.board')!.getBoundingClientRect();
    const hits = [0.2, 0.5, 0.95].map((f) => document.elementFromPoint(board.left + board.width / 2, board.top + board.height * f));
    const frame = document.querySelector('.board-layout')!;
    return {
      onBoard: hits.every((h) => Boolean(h?.closest('.board'))),
      passThrough: [...frame.querySelectorAll('*'), frame].some((el) => getComputedStyle(el).pointerEvents === 'none' && !el.closest('.board') && el.matches('.side.panel, .side.panel > *, .board-col')),
    };
  });
  expect(layering, `${at}: the board's touches are its own`).toEqual({ onBoard: true, passThrough: false });

  // A 90 px drag up at rest: the sheet follows the finger frame by frame, the content doesn't scroll.
  const during: Measure[] = [];
  const start = await onSheet();
  const upTrack = await frames(page, () => finger.drag(x, start, -90, { onMove: async () => void during.push(await measure(page)) }), 600);
  const tops = during.map((m) => m.top);
  for (let i = 1; i < tops.length; i++) expect(tops[i]!, `${at}: the sheet never goes back down while the finger rises (${tops.join(' ')})`).toBeLessThanOrEqual(tops[i - 1]! + 0.5);
  // With every move delivered (iOS, here WebKit), the sheet follows from the first one, inside the
  // browser's slop. (Chromium sends no moves inside its own 15 px slop: nothing to follow there.)
  if (label === 'WebKit') expect(rest.top - tops[0]!, `${at}: the sheet moves with the finger's first 9 px (${tops.join(' ')})`).toBeGreaterThan(7);
  expect(rest.top - tops.at(-1)!, `${at}: the sheet moved with the finger`).toBeGreaterThan(60);
  // Frame by frame: many small steps with the finger's 9 px moves, never a jump (today's sheet
  // jumps 172 px in a frame). Two moves can land in one frame, with the end of the browser's slop.
  const steps = tops.map((t, i) => (i ? tops[i - 1]! - t : rest.top - t));
  expect(Math.max(...steps), `${at}: no jump (${tops.join(' ')})`).toBeLessThanOrEqual(30);
  expect(steps.filter((s) => s > 3).length, `${at}: frame by frame (${tops.join(' ')})`).toBeGreaterThanOrEqual(6);
  for (const m of during) {
    expect(m.offset, `${at}: the content doesn't scroll in the sheet`).toBeCloseTo(rest.offset, 0);
    expect(m.bodyScroll).toBe(0);
  }
  expect(during.at(-1)!.board, `${at}: the board shrinks as the sheet rises`).toBeLessThan(rest.board - 20);
  // On release it settles up, animated.
  const released = during.at(-1)!.scroll;
  expectAnimated(upTrack.slice(upTrack.findLastIndex((f) => Math.abs(f.s - released) <= 2)), released, rest.d, `${at}: settles up`);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
  const up = await settled(page);
  expect(up.offset, `${at}: the content is still at its top`).toBeCloseTo(rest.offset, 0);
  expect(up.board).toBeLessThan(rest.board * 0.6);

  // Up: a drag down that starts with the content at its top lowers the sheet, following the finger.
  const down: Measure[] = [];
  await finger.drag(x, up.top + 40, 100, { onMove: async () => void down.push(await measure(page)) });
  expect(down.at(-1)!.top - up.top, `${at}: the sheet follows the finger down`).toBeGreaterThan(60);
  for (let i = 1; i < down.length; i++) expect(down[i]!.top).toBeGreaterThanOrEqual(down[i - 1]!.top - 0.5);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  expect((await settled(page)).scroll, `${at}: back at rest`).toBe(0);

  // A short fast flick up raises the sheet; a slow 40 px drag returns it to rest.
  await finger.drag(x, await onSheet(), -60, { steps: 3, stepMs: 8 });
  await expect(handle(page), `${at}: a flick raises the sheet`).toHaveAttribute('aria-expanded', 'true');
  expect(Math.abs((await settled(page)).scroll - rest.d)).toBeLessThanOrEqual(2);
  // A tap straight after the flick lands, whatever is left of the browser's momentum.
  const tapDown = await frames(page, () => tapOn(page, finger, '.sheet-handle'));
  expectAnimated(tapDown, rest.d, 0, `${at}: a tap on the handle, straight after a flick, lets the sheet down`);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  await finger.drag(x, await onSheet(), -40, { steps: 10, stepMs: 40 });
  await page.waitForTimeout(500);
  await expect(handle(page), `${at}: a slow 40 px drag goes back`).toHaveAttribute('aria-expanded', 'false');
  expect((await settled(page)).scroll).toBe(0);

  // The handle: a tap toggles it up, animated.
  const tapUp = await frames(page, () => tapOn(page, finger, '.sheet-handle'));
  expectAnimated(tapUp, 0, rest.d, `${at}: a tap on the handle pulls the sheet up`);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');

  // Up, a drag in the content scrolls it, under the handle, which stays put.
  // (Content that fits doesn't scroll: the sheet stays as it is.) From just under the handle, clear
  // of the Coach's own text.
  const upNow = await settled(page);
  await finger.drag(x, upNow.top + 50, -80);
  const scrolled = await settled(page);
  expect(scrolled.top, `${at}: the handle stays under the strip`).toBeCloseTo(upNow.top, 0);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
  const contentScrolled = scrolled.scroll > rest.d + 20;
  if (contentScrolled) expect(scrolled.offset, `${at}: the content moved under the handle`).toBeLessThan(rest.offset - 20);

  // The board strip: a tap brings the board back, animated.
  const fromScroll = (await measure(page)).scroll;
  const stripTrack = await frames(page, () => tapOn(page, finger, '.strip-tap'));
  expectAnimated(stripTrack, fromScroll, 0, `${at}: a tap on the strip brings the board back`);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  expect((await measure(page)).board).toBeCloseTo(rest.board, 0);

  // A touch that starts on the Ask box never moves the sheet.
  const ask = page.getByRole('textbox', { name: 'Your Why Question' });
  if (await ask.isVisible()) {
    const box = (await ask.boundingBox())!;
    await finger.drag(box.x + box.width / 2, box.y + box.height / 2, -90);
    await page.waitForTimeout(400);
    expect((await measure(page)).scroll, `${at}: the Ask box never drags`).toBe(0);
    await expect(handle(page)).toHaveAttribute('aria-expanded', 'false');
  }

  // Taps on buttons in the sheet still work.
  if (screen === 'lesson') {
    await tapOn(page, finger, 'button:text-is("Continue")');
    await expect(page.locator('.head-line')).toContainText('Decision 2 of');
    await page.getByRole('button', { name: 'Hint' }).tap();
    await expect(page.getByRole('button', { name: 'Show the move' })).toBeVisible();
  } else if (screen === 'review') {
    await tapOn(page, finger, '[role="tab"]#tab-moves');
    await expect(page.getByRole('tab', { name: 'Moves' })).toHaveAttribute('aria-selected', 'true');
  } else if (screen === 'engine') {
    const live = page.getByRole('checkbox', { name: 'Live Coaching in this game' });
    const was = await live.isChecked();
    const box = (await live.boundingBox())!;
    await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(live).toBeChecked({ checked: !was });
  } else if (screen === 'puzzles') {
    const fen = await page.getByRole('group', { name: 'Puzzle board' }).getAttribute('data-fen');
    // The solution's first move (the board shows its last), with the sheet up so it is in view.
    await tapOn(page, finger, '.sheet-handle');
    await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
    await settled(page);
    const first = page.getByRole('region', { name: 'Puzzle' }).getByRole('button', { name: /^Move \d+\./ }).first();
    const box = (await first.boundingBox())!;
    await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole('group', { name: 'Puzzle board' })).not.toHaveAttribute('data-fen', fen ?? '');
  } else if (screen === 'board') {
    // The first move in the list, where the resting sheet shows it above the Ask box.
    const row = page.getByRole('list', { name: 'Moves' }).getByRole('listitem').first();
    const ask = (await page.locator('.side.panel > .coach').boundingBox())?.y ?? Infinity;
    const box = await row.getByRole('button').boundingBox();
    if (box && box.y + box.height < ask) {
      await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(row).toHaveClass(/current/);
    }
  }
  return { contentScrolled };
}

for (const screen of SCREENS) {
  test(`Version 2 sheet on the ${screen}, Chromium with real touch, at four iPhone sizes`, async ({ browser, app }) => {
    test.setTimeout(360_000);
    const scrolled: string[] = [];
    for (const [width, height] of SIZES) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      const page = await pairedPage(context, app);
      await open(page, app.url, screen);
      if ((await journey(page, await realFinger(page), screen, width, 'Chromium')).contentScrolled) scrolled.push(`${width}×${height}`);
      await context.close();
    }
    // The Lesson's content after a move is longer than the sheet at least on the shortest phone.
    if (screen === 'lesson') expect(scrolled).toContain('390×664');
  });

  test(`Version 2 sheet on the ${screen}, WebKit with synthetic touch, at four iPhone sizes`, async ({ app }) => {
    test.setTimeout(360_000);
    const wk: Browser = await webkit.launch();
    try {
      for (const [width, height] of SIZES) {
        const context = await wk.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
        const page = await pairedPage(context, app);
        await open(page, app.url, screen);
        await journey(page, syntheticFinger(page), screen, width, 'WebKit');
        await context.close();
      }
    } finally {
      await wk.close();
    }
  });
}

async function pairedPage(context: BrowserContext, app: AppFixture): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${app.url}/?sheet=2#pair=${app.code}`);
  await expect(page.getByRole('status', { name: 'Connection' })).toHaveText(/Desktop connected/);
  return page;
}

test('Version 2 sheet: with reduced motion the sheet moves without animation', async ({ browser, app }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await pairedPage(context, app);
  await open(page, app.url, 'board');
  const finger = await realFinger(page);
  const d = (await measure(page)).d;
  const track = await frames(page, () => tapOn(page, finger, '.sheet-handle'));
  expect(track.filter((f) => f.s > 2 && f.s < d - 2), `no frames on the way: ${track.map((f) => f.s).join(' ')}`).toHaveLength(0);
  await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
  expect(Math.abs(track.at(-1)!.s - d)).toBeLessThanOrEqual(2);
  await context.close();
});

test('Version 2 sheet: an opened key moment and the current move show clear of the tabs, in the sheet', async ({ browser, app }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await pairedPage(context, app);
  await open(page, app.url, 'review');
  const finger = await realFinger(page);
  const moments = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
  /** Drawn where it is, uncovered (the tabs, the handle and the Coach cover nothing of it), between the handle and the Coach. */
  const inSheet = (el: Locator) =>
    el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const top = document.querySelector('.sheet-handle')!.getBoundingClientRect().bottom;
      const bottom = document.querySelector('.side.panel > .coach')!.getBoundingClientRect().top;
      const x = r.left + r.width / 2;
      const hits = [r.top + 2, r.top + r.height / 2].every((y) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && (node === hit || node.contains(hit)));
      });
      return hits && r.top >= top - 1 && r.bottom <= bottom + 1;
    });
  /** Brings a row into reach the way a Player does: a drag of the content, then a tap. */
  const tapInSheet = async (el: Locator) => {
    for (let i = 0; i < 6 && !(await inSheet(el)); i++) {
      const box = (await el.boundingBox())!;
      const coach = (await page.locator('.side.panel > .coach').boundingBox())!;
      const top = (await page.locator('.sheet-handle').boundingBox())!;
      const dy = box.y + box.height > coach.y ? -Math.min(200, box.y + box.height - coach.y + 20) : Math.min(200, top.y + 60 - box.y);
      await finger.drag(195, dy < 0 ? coach.y - 30 : top.y + 60, dy);
      await settled(page);
    }
    const box = (await el.boundingBox())!;
    await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  // Each moment opened by the Player: the sheet comes up, the moment's row under the tabs.
  for (const i of [1, 2, 3]) {
    const show = moments.nth(i).getByRole('button', { name: /^Show moment/ });
    await tapInSheet(show);
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    await expect(handle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => inSheet(show), { message: `moment ${i} under the tabs` }).toBe(true);
  }
  // Stepping back through the moves, the current one stays in sight under the tabs.
  await tapInSheet(page.getByRole('tab', { name: 'Moves' }));
  await expect(page.getByRole('tab', { name: 'Moves' })).toHaveAttribute('aria-selected', 'true');
  const current = page.getByRole('list', { name: 'Moves' }).locator('li.current');
  const previous = page.getByRole('button', { name: 'Previous move' });
  for (let step = 0; step < 12; step++) {
    const box = (await previous.boundingBox())!;
    await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => inSheet(current), { message: `after ${step + 1} steps back` }).toBe(true);
  }
  await context.close();
});

test('Version 2 sheet: a tap during and straight after a flick lands, first time', async ({ browser, app }) => {
  test.setTimeout(300_000);
  // Chromium keeps a fling going after the sheet arrives, and takes a tap during it to stop the fling,
  // with no click: on a button in the sheet, the board strip or a square, the tap must land all the same.
  for (const wait of [0, 80, 160, 400]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await pairedPage(context, app);
    await open(page, app.url, 'lesson');
    const finger = await realFinger(page);
    await finger.drag(195, (await measure(page)).top + 34, -60, { steps: 3, stepMs: 8 });
    if (wait) await page.waitForTimeout(wait);
    const line = page.locator('.head-line');
    const before = await line.textContent();
    const box = (await page.getByRole('button', { name: 'Continue' }).boundingBox())!;
    await finger.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(line, `a tap on Continue ${wait} ms after a flick`).not.toHaveText(before ?? '');
    await context.close();
  }
});

test('Version 2 sheet: the desktop is unchanged', async ({ paired, app }) => {
  // The same screens laid out the same with Version 2 as with today's: the sheet is a phone's alone.
  const boxes = async (variant: string, hash: string) => {
    await paired.goto(`${app.url}/?sheet=${variant}${hash}`);
    await expect(paired.locator('.side.panel')).toBeVisible();
    await paired.waitForTimeout(500);
    return paired.evaluate(() =>
      ['.board', '.side.panel', '.panel-body', '.side.panel > .coach', '.frame-head'].map((s) => {
        const el = document.querySelector(s);
        const r = el?.getBoundingClientRect();
        return r ? [s, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), getComputedStyle(el!).position] : [s, null];
      }),
    );
  };
  for (const hash of ['#/board', '#/puzzles/italian-game']) {
    expect(await boxes('2', hash), hash).toEqual(await boxes('0', hash));
  }
  await expect(paired.getByRole('button', { name: /^(Pull the panel up|Let the panel down)$/ })).toHaveCount(0);
});
