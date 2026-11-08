// Feature map: the phone's panel sheet, Version 1 (PROTOTYPE, #80: lib/sheet-variants/v1.ts). At rest
// nothing in the sheet scrolls and a vertical drag anywhere on it moves it with the finger, the
// board shrinking as it rises; let go, it slides where it was heading. Pulled up, the content
// scrolls, and a drag down from the content's top lowers it. Every move the app makes itself slides
// too. Every page loads with `?sheet=1`.
//
// Touches are real in Chromium (the DevTools protocol's touch events, which scroll natively) and
// synthetic in WebKit (TouchEvents dispatched in the page; its scrolling is imitated where nothing
// stopped it). Measured frame by frame: the sheet's top edge, the content's scroll, and the board's
// laid-out height, which must not change while a finger holds the sheet (only transforms do).
import { existsSync } from 'node:fs';
import { webkit, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { connection, expect, test, type AppFixture } from '../fixtures/app.ts';

const SIZES = [
  [390, 664],
  [402, 714],
  [440, 790],
  [390, 844],
] as const;
const SCREENS = ['Lesson', 'Review', 'Puzzles', 'Engine Game', 'Board'] as const;
type Screen = (typeof SCREENS)[number];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** One finger on the screen. */
interface Finger {
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  up(): Promise<void>;
}

/** Chromium: real touches through the DevTools protocol, scrolled and tapped by the browser itself. */
function cdpFinger(cdp: CDPSession): Finger {
  let last = { x: 0, y: 0 };
  return {
    down: async (x, y) => {
      last = { x, y };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    },
    move: async (x, y) => {
      last = { x, y };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    },
    up: async () => {
      void last;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
  };
}

/**
 * WebKit: TouchEvents made in the page (WebKit on Linux has no touch input of its own). Where no
 * listener stopped a move, the browser's own scroll is imitated on the box under the finger.
 */
function syntheticFinger(page: Page): Finger {
  const send = (type: string, x: number, y: number) =>
    page.evaluate(
      ({ type, x, y }) => {
        const w = window as unknown as { __touch?: { target: Element; scroller: HTMLElement | null; y: number } };
        if (type === 'touchstart') {
          const target = document.elementFromPoint(x, y)!;
          let scroller: HTMLElement | null = target as HTMLElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          w.__touch = { target, scroller, y };
        }
        const s = w.__touch!;
        const t = { identifier: 1, target: s.target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
        const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
        const list = type === 'touchend' ? [] : [t];
        Object.defineProperty(ev, 'touches', { value: list });
        Object.defineProperty(ev, 'targetTouches', { value: list });
        Object.defineProperty(ev, 'changedTouches', { value: [t] });
        s.target.dispatchEvent(ev);
        if (type === 'touchmove' && !ev.defaultPrevented && s.scroller) s.scroller.scrollTop += s.y - y;
        s.y = y;
      },
      { type, x, y },
    );
  let last = { x: 0, y: 0 };
  return {
    down: async (x, y) => {
      last = { x, y };
      await send('touchstart', x, y);
    },
    move: async (x, y) => {
      last = { x, y };
      await send('touchmove', x, y);
    },
    up: () => send('touchend', last.x, last.y),
  };
}

interface Phone {
  page: Page;
  finger: Finger;
  kind: 'chromium' | 'webkit';
  close(): Promise<void>;
}

async function phone(kind: 'chromium' | 'webkit', browser: Browser, app: AppFixture, [width, height]: readonly [number, number]): Promise<Phone> {
  let own: Browser | null = null;
  if (kind === 'webkit') own = await webkit.launch();
  const context: BrowserContext = await (own ?? browser).newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: kind === 'chromium',
    userAgent: UA,
  });
  const page = await context.newPage();
  await page.goto(`${app.url}/?sheet=1#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  const finger = kind === 'chromium' ? cdpFinger(await context.newCDPSession(page)) : syntheticFinger(page);
  return { page, finger, kind, close: async () => (own ? own.close() : context.close()) };
}

/** Opens a screen with its sheet at rest; the Lesson after 2. Nf3, with a long Coach explanation. */
async function open(page: Page, app: AppFixture, screen: Screen): Promise<void> {
  const go = (hash: string) => page.goto(`${app.url}/?sheet=1${hash}`);
  if (screen === 'Lesson') {
    await go('#/lesson/italian-game');
    await page.getByRole('button', { name: /^(Start the Lesson|Start from the beginning)$/ }).first().click();
    const sq = (s: string) => page.getByRole('group', { name: /Lesson board$/ }).getByRole('button', { name: new RegExp(`^${s},`) });
    await app.script({ kind: 'reply', reply: { text: 'e4 takes the centre.' } });
    await sq('e2').click();
    await sq('e4').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await app.script({ kind: 'reply', reply: { text: LONG } });
    await sq('g1').click();
    await sq('f3').click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByLabel('Coach conversation')).toContainText('gains time');
  } else if (screen === 'Review') {
    await go('#/review/1');
    const start = page.getByRole('button', { name: 'Start the Review' });
    const moments = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
    await expect(start.or(moments.first())).toBeVisible({ timeout: 90_000 });
    if (await start.isVisible()) await start.click();
    await expect(moments.first()).toBeVisible({ timeout: 90_000 });
  } else if (screen === 'Puzzles') {
    await go('#/puzzles/italian-game');
    await expect(page.getByRole('region', { name: 'Puzzle', exact: true })).toHaveAttribute('data-puzzle-id', /.+/);
  } else if (screen === 'Engine Game') {
    await go('#/engine-game');
    await page.getByRole('button', { name: 'Start the Engine Game' }).click();
    await expect(page.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  } else {
    await go('#/board');
    await expect(page.getByRole('group', { name: /board$/i }).first()).toBeVisible();
  }
  await settled(page, false);
  // The screen has drawn and measured itself (Version 1 warms its measures a moment after).
  await page.waitForTimeout(500);
}

const LONG =
  'Nf3 is the move this Lesson teaches, and it does two jobs at once. It develops a piece towards the centre, where a knight is strongest, and it attacks the pawn on e5 straight away, so Black has to spend the next move defending it. That is why it is played so often: it gains time. Notice too that the knight does not block your c-pawn or your bishop on f1, which is heading for c4 next.';

interface Frame {
  top: number;
  scrollTop: number;
  boardLaidOut: number;
  boardDrawn: number;
  moving: boolean;
  full: boolean;
}

/** The sheet as drawn now. */
function frame(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const screen = document.querySelector('.board-screen')!;
    const col = document.querySelector<HTMLElement>('.board-col')!;
    return {
      top: Math.round(document.querySelector('.side.panel')!.getBoundingClientRect().top * 10) / 10,
      scrollTop: document.querySelector<HTMLElement>('.side.panel > .panel-body')!.scrollTop,
      boardLaidOut: col.offsetHeight,
      boardDrawn: Math.round(col.querySelector('.board')!.getBoundingClientRect().height * 10) / 10,
      moving: screen.classList.contains('v1-moving'),
      full: screen.classList.contains('sheet-full'),
    };
  });
}

/** Waits for the next frame to be drawn, so what a move did shows. */
const nextFrame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The sheet has stopped, up or at rest, and the handle says so. */
async function settled(page: Page, up: boolean): Promise<void> {
  await expect.poll(async () => (await frame(page)).moving, { timeout: 5_000 }).toBe(false);
  await expect(page.locator('.board-screen')).toHaveClass(up ? /sheet-full/ : /^(?!.*sheet-full)/);
  await expect(page.getByRole('button', { name: up ? 'Let the panel down' : 'Pull the panel up' })).toHaveAttribute('aria-expanded', String(up));
}

/**
 * Records the sheet's drawn top every 8 ms for `ms`, starting now. Read from the page on a timer
 * rather than per frame: a busy headless browser draws few frames, but where the sheet is drawn at
 * any moment is still the slide's.
 */
async function recordTops(page: Page, ms: number): Promise<() => Promise<Tops>> {
  await page.evaluate((ms) => {
    const w = window as unknown as { __tops: number[]; __slide: number[]; __at: number[] };
    w.__tops = [];
    w.__slide = [];
    w.__at = [];
    const end = performance.now() + ms;
    const tick = setInterval(() => {
      const panel = document.querySelector('.side.panel')!;
      w.__tops.push(Math.round(panel.getBoundingClientRect().top * 10) / 10);
      w.__at.push(performance.now());
      // How far through its slide the panel's animation is, as the browser times it.
      const p = panel.getAnimations()[0]?.effect?.getComputedTiming().progress;
      if (typeof p === 'number') w.__slide.push(Math.round(p * 100) / 100);
      if (performance.now() >= end) clearInterval(tick);
    }, 8);
  }, ms);
  const read = async () => {
    await page.waitForTimeout(ms + 50);
    const { tops, slide, at } = await page.evaluate(() => {
      const w = window as unknown as { __tops: number[]; __slide: number[]; __at: number[] };
      return { tops: w.__tops, slide: w.__slide, at: w.__at };
    });
    return Object.assign(tops, { slide, at });
  };
  return read;
}

/** The sheet's drawn tops, and how far through its slide its animation was at each reading. */
type Tops = number[] & { slide: number[]; at: number[] };

/**
 * The sheet slid: it was drawn at three or more places strictly between where it started and
 * ended, or its animation's own clock was read part-way through three or more times. Headless
 * WebKit on Linux, with other browsers running beside it, draws (and so advances its animation
 * clock) only now and then, so there it is enough that the panel was animated and moved only
 * towards where it ended (`strict` false); standalone it slides frame by frame (see the PR).
 */
function expectSlid(tops: Tops, from: number, to: number, strict = true): void {
  const lo = Math.min(from, to) + 2;
  const hi = Math.max(from, to) - 2;
  const between = new Set(tops.filter((t) => t > lo && t < hi));
  const partWay = new Set(tops.slide.filter((p) => p > 0 && p < 1));
  const why = `drawn between ${from} and ${to}: ${tops.join(' ')}; slide ${tops.slide.join(' ')}`;
  if (strict) expect(Math.max(between.size, partWay.size), why).toBeGreaterThanOrEqual(3);
  else expect(tops.slide.length, why).toBeGreaterThan(0);
  // Never past where it ends up, and never back towards where it started.
  const dir = Math.sign(to - from);
  for (let i = 1; i < tops.length; i++) expect((tops[i]! - tops[i - 1]!) * dir, `${tops.join(' ')}`).toBeGreaterThanOrEqual(-1);
}

/** How long to watch a slide for: a busy headless WebKit is slow to deliver a tap. */
const watchMs = (p: Phone) => (p.kind === 'webkit' ? 1_500 : 450);

/** A point on the sheet's content, away from its buttons' edges: where a thumb would read. */
async function onContent(page: Page): Promise<{ x: number; y: number }> {
  const r = (await page.locator('.side.panel > .panel-body').boundingBox())!;
  return { x: Math.round(r.x + r.width * 0.75), y: Math.round(r.y + Math.min(40, r.height / 2)) };
}

/** A vertical drag of `dy` px in `steps` moves `ms` apart, frame by frame; the finger stays down. */
async function drag(p: Phone, at: { x: number; y: number }, dy: number, steps = 10, ms = 16): Promise<Frame[]> {
  const frames = [await frame(p.page)];
  await p.finger.down(at.x, at.y);
  for (let i = 1; i <= steps; i++) {
    await p.finger.move(at.x, at.y + (dy * i) / steps);
    await nextFrame(p.page);
    frames.push(await frame(p.page));
    if (ms > 16) await p.page.waitForTimeout(ms - 16);
  }
  return frames;
}

/**
 * Done means 1: a 90 px drag up on the resting sheet moves it with the finger frame by frame (once
 * past the 8 px that tells a drag from a tap), scrolls nothing and lays nothing out again; let go,
 * it slides up.
 */
async function dragUpFollows(p: Phone): Promise<void> {
  const page = p.page;
  const rest = await frame(page);
  const frames = await drag(p, await onContent(page), -90);
  for (const [i, f] of frames.entries()) {
    const travel = 9 * i;
    // Exactly the finger's travel since it touched, from the first move the page hears (Chromium
    // holds back the moves inside its own 15 px slop, so the first 9 px may not be heard).
    if (travel >= 18 || f.top !== rest.top) expect(f.top, `frame ${i}`).toBeCloseTo(rest.top - travel, 0);
    // The content doesn't scroll (the Review may have scrolled it itself, to show the current move).
    expect(f.scrollTop, `frame ${i}`).toBe(rest.scrollTop);
    // Only transforms move it: the board's layout stays as it was, while it is drawn smaller.
    expect(f.boardLaidOut, `frame ${i}`).toBe(rest.boardLaidOut);
  }
  expect(frames.at(-1)!.boardDrawn).toBeLessThan(rest.boardDrawn - 30);
  const tops = await recordTops(page, watchMs(p));
  await p.finger.up();
  const up = await tops();
  await settled(page, true);
  const end = await frame(page);
  expect(end.top).toBeLessThan(rest.top - 100);
  expect(end.scrollTop).toBe(rest.scrollTop);
  expectSlid(up, frames.at(-1)!.top, end.top, p.kind === 'chromium');
}

/** Done means 3, the second half: pulled up, a drag down from the content's top lowers it, following the finger. */
async function dragDownFollows(p: Phone): Promise<void> {
  const page = p.page;
  // The Player scrolls the content back to its top first (the Review may have scrolled it to the current move).
  await page.locator('.side.panel > .panel-body').evaluate((b) => (b.scrollTop = 0));
  const upFrame = await frame(page);
  const frames = await drag(p, await onContent(page), 90);
  for (const [i, f] of frames.entries()) if (9 * i >= 18 || f.top !== upFrame.top) expect(f.top, `frame ${i}`).toBeCloseTo(upFrame.top + 9 * i, 0);
  // The board is laid out once for the move, at its full size, and drawn at the strip's: from
  // then on only transforms change.
  const held = frames.filter((f) => f.moving);
  expect(held.length).toBeGreaterThanOrEqual(8);
  for (const f of held) expect(f.boardLaidOut).toBe(held[0]!.boardLaidOut);
  // Drawn without a jump: as much bigger than the strip as the sheet has come down, about.
  const first = held[0]!.top - upFrame.top;
  expect(held[0]!.boardDrawn).toBeGreaterThan(upFrame.boardDrawn + first * 0.5);
  expect(held[0]!.boardDrawn).toBeLessThan(upFrame.boardDrawn + first * 1.5 + 1);
  const tops = await recordTops(page, watchMs(p));
  await p.finger.up();
  const down = await tops();
  await settled(page, false);
  expectSlid(down, frames.at(-1)!.top, (await frame(page)).top, p.kind === 'chromium');
}

/** A tap on the handle toggles the sheet, sliding both ways. */
async function handleToggles(p: Phone): Promise<void> {
  const page = p.page;
  const rest = await frame(page);
  const handle = page.getByRole('button', { name: 'Pull the panel up' });
  let tops = await recordTops(page, watchMs(p));
  await handle.tap();
  const up = await tops();
  await settled(page, true);
  const upTop = (await frame(page)).top;
  expectSlid(up, rest.top, upTop, p.kind === 'chromium');
  tops = await recordTops(page, watchMs(p));
  await page.getByRole('button', { name: 'Let the panel down' }).tap();
  expectSlid(await tops(), upTop, rest.top, p.kind === 'chromium');
  await settled(page, false);
}

for (const kind of ['chromium', 'webkit'] as const) {
  test.describe(`Version 1 of the sheet, ${kind === 'chromium' ? 'Chromium with real touches' : 'WebKit with synthetic touches'}`, () => {
    test.skip(kind === 'webkit' && !existsSync(webkit.executablePath()), 'WebKit is not installed here (npx playwright install webkit)');

    for (const screen of SCREENS) {
      test(`${screen}, at every phone size: a drag up follows the finger without scrolling, a drag down from the top lowers it, the handle toggles it`, async ({ browser, app }) => {
        for (const size of SIZES) {
          const p = await phone(kind, browser, app, size);
          try {
            await open(p.page, app, screen);
            await test.step(`${size.join('×')}: drag up`, () => dragUpFollows(p));
            await test.step(`${size.join('×')}: drag down`, () => dragDownFollows(p));
            await test.step(`${size.join('×')}: handle`, () => handleToggles(p));
          } finally {
            await p.close();
          }
        }
      });
    }

    test('a short flick raises the sheet; a slow 40 px drag returns it to rest', async ({ browser, app }) => {
      const p = await phone(kind, browser, app, [390, 664]);
      try {
        await open(p.page, app, 'Lesson');
        const rest = await frame(p.page);
        // Fast: 45 px in three moves a frame apart, let go at once.
        const at = await onContent(p.page);
        await p.finger.down(at.x, at.y);
        for (const dy of [15, 30, 45]) {
          await p.page.waitForTimeout(16);
          await p.finger.move(at.x, at.y - dy);
        }
        await p.finger.up();
        await settled(p.page, true);
        await p.page.getByRole('button', { name: 'Let the panel down' }).tap();
        await settled(p.page, false);
        expect((await frame(p.page)).top).toBeCloseTo(rest.top, 0);
        // Slow: 40 px over half a second, then held still before letting go.
        const frames = await drag(p, await onContent(p.page), -40, 8, 60);
        expect(frames.at(-1)!.top).toBeCloseTo(rest.top - 40, 0);
        await p.page.waitForTimeout(150);
        const tops = await recordTops(p.page, watchMs(p));
        await p.finger.up();
        expectSlid(await tops(), rest.top - 40, rest.top, kind === 'chromium');
        await settled(p.page, false);
      } finally {
        await p.close();
      }
    });

    test('pulled up, a drag in the content scrolls it and the sheet stays; a drag down that starts scrolled only scrolls back', async ({ browser, app }) => {
      const p = await phone(kind, browser, app, [390, 664]);
      try {
        await open(p.page, app, 'Review');
        await p.page.getByRole('button', { name: 'Pull the panel up' }).tap();
        await settled(p.page, true);
        const up = await frame(p.page);
        const at = await onContent(p.page);
        const frames = await drag(p, { x: at.x, y: at.y + 150 }, -120);
        await p.finger.up();
        await settled(p.page, true);
        expect((await frame(p.page)).scrollTop).toBeGreaterThan(40);
        for (const f of frames) expect(f.top).toBeCloseTo(up.top, 0);
        // A drag down from part-way scrolls back towards the top, and the sheet stays up.
        const back = await drag(p, at, 30);
        await p.finger.up();
        for (const f of back) expect(f.top).toBeCloseTo(up.top, 0);
        await settled(p.page, true);
      } finally {
        await p.close();
      }
    });

    test('taps still work: the handle, the board strip, Continue and a key moment; a touch on the Ask box never moves the sheet', async ({ browser, app }) => {
      const p = await phone(kind, browser, app, [390, 664]);
      const page = p.page;
      try {
        await open(page, app, 'Lesson');
        const rest = await frame(page);
        // A drag that starts on the Ask box: the sheet stays where it is.
        const ask = (await page.getByRole('textbox', { name: 'Your Why Question' }).boundingBox())!;
        const frames = await drag(p, { x: ask.x + 30, y: ask.y + ask.height / 2 }, -90);
        await p.finger.up();
        for (const f of frames) expect(f.top).toBeCloseTo(rest.top, 0);
        await settled(page, false);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForTimeout(500);
        // The handle, then the strip, which brings the board back, sliding.
        await page.getByRole('button', { name: 'Pull the panel up' }).tap();
        await settled(page, true);
        const upTop = (await frame(page)).top;
        const tops = await recordTops(page, watchMs(p));
        await page.getByRole('button', { name: 'Show the board full size' }).tap();
        expectSlid(await tops(), upTop, rest.top, kind === 'chromium');
        await settled(page, false);
        // Continue, tapped in the resting sheet: the Lesson moves on.
        await page.getByRole('button', { name: 'Continue' }).tap();
        await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
        await expect(page.getByText(/Decision 3 of/)).toBeVisible();
        // A key moment in the Review opens with a tap.
        await open(page, app, 'Review');
        const show = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first().getByRole('button', { name: /^Show moment/ });
        const before = await show.getAttribute('aria-expanded');
        await show.tap();
        await expect(show).toHaveAttribute('aria-expanded', before === 'true' ? 'false' : 'true');
      } finally {
        await p.close();
      }
    });
  });
}

test.describe('Version 1 of the sheet: the moves the app makes itself slide', () => {
  test('the handle, the strip, a Why Question, the keyboard and Continue all slide; a tap mid-slide turns it round', async ({ browser, app }) => {
    const p = await phone('chromium', browser, app, [390, 664]);
    const page = p.page;
    try {
      await open(page, app, 'Lesson');
      const rest = (await frame(page)).top;
      // The keyboard: the Ask box's focus shrinks the board to a strip, sliding, and back.
      let tops = await recordTops(page, 450);
      await page.getByRole('textbox', { name: 'Your Why Question' }).focus();
      const strip = await tops();
      await expect.poll(async () => (await frame(page)).moving).toBe(false);
      const typingTop = (await frame(page)).top;
      expect(typingTop).toBeLessThan(rest - 100);
      expectSlid(strip, rest, typingTop);
      // The first drag down, anywhere on the sheet, closes the keyboard; the board slides back.
      tops = await recordTops(page, 1_000);
      await drag(p, await onContent(page), 40, 4);
      await p.finger.up();
      expectSlid(await tops(), typingTop, rest);
      await expect(page.getByRole('textbox', { name: 'Your Why Question' })).not.toBeFocused();
      await settled(page, false);
      // A Why Question pulls the sheet up for its answer, sliding.
      await app.script({ kind: 'reply', reply: { text: 'It attacks e5 and develops.' } });
      await page.getByRole('textbox', { name: 'Your Why Question' }).fill('Why does it matter that it attacks e5?');
      await expect.poll(async () => (await frame(page)).top).toBeCloseTo(typingTop, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(500);
      await expect.poll(async () => (await frame(page)).top).toBeCloseTo(rest, 0);
      await settled(page, false);
      tops = await recordTops(page, 600);
      // Sent as the Ask button sends it (a tap on the button focuses it, which grows the Coach's
      // log at rest and moves the button from under the finger: Today's layout, not the gesture's).
      await page.locator('.coach form').evaluate((f: HTMLFormElement) => f.requestSubmit());
      const asked = await tops();
      await settled(page, true);
      const up = (await frame(page)).top;
      expectSlid(asked, rest, up);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(500);
      // A tap on the handle mid-slide turns it round from where it is drawn: no jump.
      tops = await recordTops(page, 900);
      // `force`: Playwright would otherwise wait for the handle to stop moving.
      await page.getByRole('button', { name: 'Let the panel down' }).tap({ force: true });
      await page.waitForTimeout(90);
      await page.getByRole('button', { name: 'Pull the panel up' }).tap({ force: true });
      const turned = await tops();
      await settled(page, true);
      const deepest = Math.max(...turned);
      expect(deepest).toBeGreaterThan(up + 20);
      expect(deepest).toBeLessThan(rest - 2);
      // Never faster than the slide's start (4 times its average speed, about 2.5 px/ms here):
      // no jump. Timed by the readings' own clock, as a busy page reads less often.
      let last = 0;
      for (let i = 1; i < turned.length; i++) {
        if (turned[i] === turned[i - 1]) continue;
        // From the reading where it last changed: the browser draws it once a frame.
        const speed = Math.abs(turned[i]! - turned[last]!) / Math.max(1, turned.at[i]! - turned.at[last]!);
        expect(speed, `reading ${i}: ${turned.join(' ')}`).toBeLessThan(3.5);
        last = i;
      }
      // Continue, with the sheet up: the Lesson lets it down, sliding.
      tops = await recordTops(page, 600);
      await page.getByRole('button', { name: 'Continue' }).tap();
      expectSlid(await tops(), up, rest);
      await settled(page, false);
    } finally {
      await p.close();
    }
  });

  test('a button tapped while the sheet slides is pressed', async ({ browser, app }) => {
    const p = await phone('chromium', browser, app, [390, 664]);
    const page = p.page;
    try {
      await open(page, app, 'Lesson');
      // The slide at a twentieth of its speed, so the tap is aimed where Continue is drawn when
      // it lands, as a thumb aims at what it sees.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
      await page.getByRole('button', { name: 'Pull the panel up' }).tap();
      await page.waitForTimeout(800);
      expect(await page.locator('.board-screen').evaluate((s) => s.classList.contains('v1-moving'))).toBe(true);
      // `force`: Playwright would otherwise wait for Continue to stop moving.
      await page.getByRole('button', { name: 'Continue' }).tap({ force: true });
      await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
      await expect(page.getByText(/Decision 3 of/)).toBeVisible();
    } finally {
      await p.close();
    }
  });

  test('with less motion asked for, nothing slides: the sheet moves in one step', async ({ browser, app }) => {
    const p = await phone('chromium', browser, app, [390, 664]);
    const page = p.page;
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, app, 'Lesson');
      const rest = (await frame(page)).top;
      const tops = await recordTops(page, 450);
      await page.getByRole('button', { name: 'Pull the panel up' }).tap();
      const seen = await tops();
      await settled(page, true);
      const up = (await frame(page)).top;
      expect(seen.filter((t) => t > up + 2 && t < rest - 2)).toEqual([]);
      // A drag still follows the finger; let go, the sheet is where it goes on the next frame.
      await page.locator('.side.panel > .panel-body').evaluate((b) => (b.scrollTop = 0));
      const frames = await drag(p, await onContent(page), 90);
      expect(frames.at(-1)!.top).toBeCloseTo(up + 90, 0);
      await p.finger.up();
      await nextFrame(page);
      expect((await frame(page)).top).toBeCloseTo(rest, 0);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      await settled(page, false);
    } finally {
      await p.close();
    }
  });
});

test('on a desktop, Version 1 changes nothing: the panel is laid out and scrolls as Today', async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const measure = async (variant: string) => {
    await page.goto(`${app.url}/?sheet=${variant}#/review/1`);
    const start = page.getByRole('button', { name: 'Start the Review' });
    const moments = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
    await expect(start.or(moments.first())).toBeVisible({ timeout: 90_000 });
    if (await start.isVisible()) await start.click();
    await expect(moments.first()).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const r = (s: string) => {
        const b = document.querySelector(s)!.getBoundingClientRect();
        return [b.left, b.top, b.width, b.height].map(Math.round);
      };
      const body = document.querySelector<HTMLElement>('.side.panel > .panel-body')!;
      return {
        board: r('.board-col'),
        panel: r('.side.panel'),
        coach: r('.side.panel > .coach'),
        overflow: getComputedStyle(body).overflowY,
        touch: getComputedStyle(document.querySelector('.side.panel')!).touchAction,
        handle: document.querySelectorAll('.sheet-handle').length,
      };
    });
  };
  await page.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  const today = await measure('0');
  const v1 = await measure('1');
  expect(v1).toEqual(today);
  expect(v1.overflow).toBe('auto');
  expect(v1.handle).toBe(0);
});
