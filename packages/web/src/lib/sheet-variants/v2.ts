// PROTOTYPE (#80): version 2 of the phone's panel sheet. The sheet's motion is the browser's own
// scrolling, so the phone supplies the finger tracking, momentum and smoothness. Its CSS lives in
// src/sheet-v2.css, scoped under :root[data-sheet="v2"].
//
// The panel (`.side.panel`) becomes one scroller laid over the whole frame under the header line:
// first a see-through gap as tall as the resting board, then the sheet (handle, content, Coach).
// Scrolling it from 0 to `d` raises the sheet from its resting place to just under the board's
// strip; past `d` the content scrolls under the handle, which stays put. The board shrinks by a
// transform the scroll drives (a scroll-driven animation where the browser has one, a scroll
// listener if not), so nothing is laid out again while the sheet moves.
//
// At rest the content is cut to the sheet's height, so the scroller reaches no further than `d`: a
// swipe moves the sheet and never scrolls the text. Once the sheet has settled up, the cut goes and
// the content scrolls on from there with the browser's momentum. A pull down from the content's top
// lowers the sheet, as the same scroller carries on below `d`. Let go between rest and up, the
// sheet goes where the finger was heading, by the browser's smooth scroll.
//
// No CSS snapping: WebKit has no free scrolling inside a snap area taller than the scroller (it
// snapped the content back to its top), and both engines remember the snap they last aimed for
// and jump back to it after a layout change. The release rule does the snapping's job.
import { untrack } from 'svelte';
import type { Sheet } from '../sheet.svelte.ts';
import type { SheetDriver } from './types.ts';

const supports = (rule: string): boolean => typeof CSS !== 'undefined' && CSS.supports(rule);
/** The board follows the scroll on the compositor, in step with the sheet. */
const scrollDriven = supports('animation-timeline: scroll()') && supports('timeline-scope: --v2');
const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The quiet time after the last scroll event that counts as settled, where `scrollend` is missing or late. */
const SETTLE_MS = 160;
/** Where a box takes typing: a touch on it never moves the sheet (sheet-v2.css), and with the keyboard up a drag down closes it. */
const FIELD = 'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/** How many panels use a frame: the frame keeps its v2 class while one does. */
const users = new WeakMap<HTMLElement, number>();

/** The sheet's geometry, in CSS pixels, from the frame as laid out (transforms aside). */
interface Geometry {
  /** The resting board's height: where the sheet's top rests. */
  rest: number;
  /** The board's height as a strip: where the sheet's top is when up. */
  up: number;
  /** The scale that turns the board into the strip. */
  scale: number;
}

/**
 * The panel's hook. Untracked: an attachment re-runs when state it reads changes, and the sheet's
 * own `full` and `on` must not tear the scroller down and set it up again in the middle of a move.
 */
const panel = (sheet: Sheet, body: HTMLElement): (() => void) => untrack(() => attach(sheet, body));

function attach(sheet: Sheet, body: HTMLElement): () => void {
  const scroller = body.parentElement;
  const layout = scroller?.parentElement;
  const col = layout?.querySelector<HTMLElement>(':scope > .board-col');
  if (!scroller?.matches('.side.panel') || !layout?.matches('.board-layout') || !col) return () => undefined;

  users.set(layout, (users.get(layout) ?? 0) + 1);
  layout.classList.add('v2-sheet');
  if (scrollDriven) layout.classList.add('v2-sdt');

  let geo: Geometry = { rest: 0, up: 0, scale: 1 };
  /** The scroll from rest to up. */
  let d = 0;
  /** Settled up. */
  let open = false;
  /**
   * The content is whole and scrolls on past `d`: from the first touch, wheel or focus in the sheet
   * once it is up. Not as it settles: what is left of the browser's fling from the swipe that raised
   * it would scroll the text on, which no new gesture asked for.
   */
  let whole = false;
  /** Where a move the driver makes is going, while it is under way. */
  let target: number | null = null;
  /** How often that move was carried on after it stopped short. */
  let retries = 0;
  /** A change of `sheet.full` this driver makes itself: the sheet is already there. */
  let own = false;
  let touching = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  const written: Record<string, string> = {};
  const write = (name: string, value: string): void => {
    if (written[name] === value) return;
    written[name] = value;
    layout.style.setProperty(name, value);
  };

  /** Lays the sheet out for the frame's size: only when a size changes, never during a move. */
  const measure = (): void => {
    if (!sheet.on) return;
    const height = layout.clientHeight;
    const rest = col.offsetHeight;
    const board = col.querySelector<HTMLElement>('.board');
    const width = board?.offsetWidth || col.offsetWidth || 1;
    // Today's strip: the board at min(40vw, 30dvh) (app.css), here reached by scaling the whole column.
    const scale = Math.min(1, Math.min(innerWidth * 0.4, innerHeight * 0.3) / width);
    const up = Math.round(rest * scale);
    geo = { rest, up, scale };
    d = Math.max(0, rest - up);
    let chrome = 0;
    for (const child of scroller.children) if (child !== body) chrome += (child as HTMLElement).offsetHeight;
    const handle = scroller.querySelector<HTMLElement>(':scope > .sheet-handle');
    const coach = scroller.querySelector<HTMLElement>(':scope > .coach');
    write('--v2-rest', `${rest}px`);
    write('--v2-up', `${up}px`);
    write('--v2-d', `${d}px`);
    write('--v2-scale', String(scale));
    write('--v2-hh', `${handle?.offsetHeight ?? 0}px`);
    write('--v2-coach-h', `${coach?.offsetHeight ?? 0}px`);
    // The content's height at rest: what fills the sheet up to the Coach once it is up, so the
    // scroller ends exactly at `d` while the content is cut.
    write('--v2-body-min', `${Math.max(0, height - up - chrome)}px`);
    paint();
  };

  /** Without a scroll-driven animation: the board follows the scroll from a listener. */
  const paint = (): void => {
    frame = 0;
    if (scrollDriven) return;
    const t = d > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / d)) : 0;
    col.style.transform = t > 0 ? `scale(${1 - (1 - geo.scale) * t})` : '';
  };

  const setOpen = (value: boolean): void => {
    open = value;
    if (!value) setWhole(false);
  };
  const setWhole = (value: boolean): void => {
    if (whole === value) return;
    whole = value;
    body.classList.toggle('v2-open', value);
  };
  /** A gesture in the sheet once it is up: the content opens for it. */
  const reach = (): void => {
    if (open) setWhole(true);
  };

  /**
   * The scroll has come to rest (`scrollend`, or `quiet`: no scroll for a while): the sheet is
   * where it settled, and `sheet.full` says so.
   */
  const settle = (quiet = false): void => {
    clearTimeout(idle);
    // The finger has just let go: where the sheet goes is the release's to say, a frame on.
    if (touching || releasing || !sheet.on) return;
    const at = scroller.scrollTop;
    if (target !== null && Math.abs(at - target) > 1 && retries < 3) {
      // The scroll that ended was the finger's, cut off by the move the driver started: wait for
      // that move. Gone quiet short of its end, it carries on.
      if (quiet) {
        retries++;
        glide(target);
      } else settleSoon();
      return;
    }
    target = null;
    retries = 0;
    const up = d > 0 && at >= d - 2;
    if (!up && at > 1) {
      // Stopped between rest and up (a wheel, momentum that ran out): on to the other end, as a
      // wheel turned at rest pulls today's sheet up.
      move(!open);
      return;
    }
    setOpen(up);
    if (sheet.full !== up) {
      own = true;
      sheet.full = up;
      own = false;
    }
  };
  const settleSoon = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => settle(true), SETTLE_MS);
  };
  const scrollEnd = (): void => settle();

  /** A smooth scroll to `top`: the browser animates it, on the compositor. */
  const glide = (top: number): void => {
    target = top;
    scroller.scrollTo({ top, behavior: reduced() ? 'instant' : 'smooth' });
    settleSoon();
  };

  /** Moves the sheet the way the app asks (a tap, Read all, Continue): a smooth scroll to rest or up. */
  const move = (full: boolean): void => {
    const top = full ? d : 0;
    if (Math.abs(scroller.scrollTop - top) < 1) {
      setOpen(full);
      return;
    }
    glide(top);
  };

  // The finger's last moves, for where it was heading when it let go: its own speed, as a flick
  // can end before the scroll has reported more than once.
  let samples: { t: number; y: number }[] = [];
  let startScroll = 0;
  /**
   * A gesture that started with the content scrolled, let go with the sheet still up: what moves on
   * is the content's momentum, which stops at the content's top. Lowering the sheet takes a pull
   * from there (or the finger itself carrying on past the top).
   */
  let coastingContent = false;

  /**
   * The app just put the focus in the sheet without the keyboard (after a tap or by itself): the
   * scroll that brings it into view is the browser's, not the Player's. Until then, or a moment.
   */
  let quietFocus = false;
  let quietFocusTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Stops the browser's momentum at up. Moving the scroll back alone isn't enough: the fling would
   * keep pushing unseen. With no overflow for a frame, the browser drops it; what it still sends is
   * stopped again.
   */
  const halt = (): void => {
    scroller.style.overflowY = 'hidden';
    scroller.scrollTo({ top: d, behavior: 'instant' });
    requestAnimationFrame(() => scroller.style.removeProperty('overflow-y'));
  };
  const onScroll = (): void => {
    if (!scrollDriven && !frame) frame = requestAnimationFrame(paint);
    if (touching) return;
    // The browser bringing a focused button into view (the app moving the focus, as Puzzles does
    // after Show the solution) leaves a resting sheet at rest; focus from the keyboard raises it.
    if (quietFocus) {
      quietFocus = false;
      if (!open && target === null && scroller.scrollTop > 0) {
        scroller.scrollTo({ top: 0, behavior: 'instant' });
        return;
      }
    }
    // A flick down the content stops at its top: lowering the sheet takes a pull from there.
    if (open && target === null && coastingContent && scroller.scrollTop < d) halt();
    settleSoon();
  };
  /** The finger moved: a drag or a flick, not a tap. */
  let moved = false;
  /** The finger let go and the release waits for the next frame to see the browser's momentum. */
  let releasing = false;
  const touchMove = (e: TouchEvent): void => {
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    if (Math.abs(y - startY) > 2) moved = true;
    if (e.touches.length !== 1) return;
    samples.push({ t: e.timeStamp, y });
    while (samples.length > 2 && e.timeStamp - samples[0]!.t > 100) samples.shift();
  };

  /**
   * Let go between rest and up, the sheet goes where it was heading: its place plus about 150 ms of
   * the finger's speed, once that is past 80 px or half the way, whichever is less. The browser's
   * smooth scroll takes it there from where the finger left it, in place of its own momentum. Let
   * go at rest, up or in the content, the scroll is the browser's own.
   */
  const release = (lifted: number): void => {
    releasing = false;
    try {
      decide(lifted);
    } finally {
      settleSoon();
    }
  };
  const decide = (lifted: number): void => {
    // A move under way (a tap on the handle started it) is the Player's choice already.
    if (d <= 0 || coastingContent || target !== null) return;
    const at = scroller.scrollTop;
    if (at <= 0.5 || at >= d - 0.5) return;
    const first = samples[0];
    const last = samples.at(-1);
    // The finger up is the scroll down: scroll pixels per millisecond.
    const speed = first && last && last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0;
    // The browser's momentum since the finger lifted says the same, where the finger's moves came
    // in too few to tell (a quick flick, moves merged into one frame).
    const coasting = at - lifted;
    const heading = Math.abs(coasting) > 2 ? at + coasting * 9 : at + speed * 150;
    const enough = Math.min(80, d / 2);
    const up = startScroll <= 1 ? heading >= enough : d - heading < enough;
    glide(up ? d : 0);
  };

  // A box that takes typing: with the keyboard up, the first drag down closes it rather than move the sheet.
  let field: HTMLElement | null = null;
  let startY = 0;
  let closing = false;
  /** Whether the sheet was up when the Ask box took the focus: it goes back down if nothing was asked. */
  let upBeforeTyping: boolean | null = null;
  /** That, waiting for the finger to lift. */
  let lowerAfterTouch = false;
  let asked = false;
  const guard = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) return;
    if (!closing) {
      if (!field || document.activeElement !== field || t.clientY - startY < 2) return;
      closing = true;
      field.blur();
    }
    if (e.cancelable) e.preventDefault();
  };
  const guarding = (on: boolean): void => {
    if (on) scroller.addEventListener('touchmove', guard, { passive: false });
    else scroller.removeEventListener('touchmove', guard);
  };

  const touchStart = (e: TouchEvent): void => {
    touching = true;
    clearTimeout(idle);
    // The finger takes over from a move under way.
    target = null;
    releasing = false;
    coastingContent = false;
    retries = 0;
    reach();
    startY = e.touches[0]?.clientY ?? 0;
    startScroll = scroller.scrollTop;
    samples = [{ t: e.timeStamp, y: startY }];
    moved = false;
    closing = false;
  };
  const touchEnd = (e: TouchEvent): void => {
    if (e.touches.length) return;
    touching = false;
    if (closing && !field) guarding(false);
    closing = false;
    if (lowerAfterTouch) {
      lowerAfterTouch = false;
      sheet.full = false;
      return;
    }
    const lifted = scroller.scrollTop;
    coastingContent = open && startScroll > d + 1 && lifted >= d - 1;
    if (moved && Math.abs(lifted - startScroll) > 1) {
      releasing = true;
      requestAnimationFrame(() => release(lifted));
    }
    settleSoon();
  };

  const focusIn = (e: FocusEvent): void => {
    const target = e.target;
    reach();
    if (target instanceof HTMLElement && !target.matches(':focus-visible') && !touching) {
      quietFocus = true;
      clearTimeout(quietFocusTimer);
      quietFocusTimer = setTimeout(() => (quietFocus = false), 600);
    }
    if (!(target instanceof HTMLElement) || !target.matches(FIELD)) return;
    if (!field) guarding(true);
    field = target;
    // Typing a question: the board makes room as a strip, as today's sheet shrinks it (app.css).
    if (target.closest('.coach') && upBeforeTyping === null) {
      upBeforeTyping = sheet.full;
      asked = false;
      sheet.pullUp();
    }
  };
  const focusOut = (): void => {
    // Where the focus went is known only after the event.
    setTimeout(() => {
      const now = document.activeElement;
      if (now instanceof HTMLElement && scroller.contains(now) && now.matches(FIELD)) return;
      field = null;
      if (!closing) guarding(false);
      // Nothing asked: the sheet goes back down, as today's board grows back, once the finger is off.
      if (upBeforeTyping === false && !asked && sheet.full) {
        if (touching) lowerAfterTouch = true;
        else sheet.full = false;
      }
      upBeforeTyping = null;
    }, 400);
  };
  const submit = (): void => {
    asked = true;
  };
  /** A wheel is a gesture of its own: it may scroll the content once the sheet is up. */
  const wheel = (): void => {
    coastingContent = false;
    reach();
  };

  const stopListening = sheet.listen((full) => {
    if (!own) move(full);
  });

  const sizes = new ResizeObserver(() => measure());
  const watchChildren = (): void => {
    sizes.disconnect();
    sizes.observe(layout);
    sizes.observe(col);
    for (const child of scroller.children) if (child !== body) sizes.observe(child);
  };
  const children = new MutationObserver(watchChildren);
  children.observe(scroller, { childList: true });
  watchChildren();
  measure();
  scroller.scrollTop = sheet.full ? d : 0;
  setOpen(sheet.full);
  if (sheet.full) setWhole(true);

  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('scrollend', scrollEnd);
  scroller.addEventListener('touchstart', touchStart, { passive: true });
  scroller.addEventListener('touchmove', touchMove, { passive: true });
  scroller.addEventListener('touchend', touchEnd, { passive: true });
  scroller.addEventListener('touchcancel', touchEnd, { passive: true });
  scroller.addEventListener('focusin', focusIn);
  scroller.addEventListener('focusout', focusOut);
  scroller.addEventListener('submit', submit, true);
  scroller.addEventListener('wheel', wheel, { passive: true });

  return () => {
    stopListening();
    sizes.disconnect();
    children.disconnect();
    clearTimeout(idle);
    clearTimeout(quietFocusTimer);
    cancelAnimationFrame(frame);
    guarding(false);
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('scrollend', scrollEnd);
    scroller.removeEventListener('touchstart', touchStart);
    scroller.removeEventListener('touchmove', touchMove);
    scroller.removeEventListener('touchend', touchEnd);
    scroller.removeEventListener('touchcancel', touchEnd);
    scroller.removeEventListener('focusin', focusIn);
    scroller.removeEventListener('focusout', focusOut);
    scroller.removeEventListener('submit', submit, true);
    scroller.removeEventListener('wheel', wheel);
    body.classList.remove('v2-open');
    col.style.transform = '';
    const left = (users.get(layout) ?? 1) - 1;
    users.set(layout, left);
    if (left === 0) {
      layout.classList.remove('v2-sheet', 'v2-sdt');
      for (const name of Object.keys(written)) layout.style.removeProperty(name);
    }
  };
}

/**
 * A tap that answers even while the browser's momentum still runs. A tap during a fling only stops
 * it, and the browser sends no click (Chromium keeps a fling going even when it has nowhere left to
 * go, as after a flick that raised the sheet). A touch that goes down and up without moving is a tap
 * all the same; the click that may follow is the same tap, not a second. A mouse or the keyboard
 * clicks as usual.
 */
function tapped(node: HTMLElement, act: () => void): () => void {
  let down: { id: number; x: number; y: number; t: number } | null = null;
  let tookTap = -Infinity;
  const pointerDown = (e: PointerEvent): void => {
    down = e.pointerType === 'touch' ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  };
  const pointerUp = (e: PointerEvent): void => {
    const was = down;
    down = null;
    if (!was || e.pointerId !== was.id) return;
    if (Math.hypot(e.clientX - was.x, e.clientY - was.y) > 10 || e.timeStamp - was.t > 600) return;
    tookTap = performance.now();
    act();
  };
  const cancel = (): void => {
    down = null;
  };
  const click = (): void => {
    if (performance.now() - tookTap < 800) {
      tookTap = -Infinity;
      return;
    }
    act();
  };
  node.addEventListener('pointerdown', pointerDown);
  node.addEventListener('pointerup', pointerUp);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click);
  return () => {
    node.removeEventListener('pointerdown', pointerDown);
    node.removeEventListener('pointerup', pointerUp);
    node.removeEventListener('pointercancel', cancel);
    node.removeEventListener('click', click);
  };
}

export const v2: SheetDriver = {
  panel,
  /** A tap toggles; a drag on it is the sheet's own scroll (touch-action in sheet-v2.css), which ends in no tap. */
  handle: (sheet, node) => tapped(node, () => sheet.toggle()),
  /** A tap on the strip brings the board back: the sheet scrolls down to rest. */
  strip: (sheet, node) =>
    tapped(node, () => {
      sheet.full = false;
    }),
  /** The frame needs nothing of its own: the panel's hook finds the board beside it. */
  frame: () => () => undefined,
};
