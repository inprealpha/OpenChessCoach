// PROTOTYPE (#80): version 2 of the phone's panel sheet. The sheet's motion is the browser's own
// scrolling, so the phone supplies the finger tracking, momentum and smoothness. Its CSS lives in
// src/sheet-v2.css, scoped under :root[data-sheet="v2"].
//
// The panel (`.side.panel`) becomes one scroller laid over the frame under the header line, below
// the board: first a gap as tall as the resting board (the board itself covers it, so the board's
// touches are its own), then the sheet (handle, content, Coach). Scrolling it from 0 to `d` raises
// the sheet from its resting place to just under the board's strip; past `d` the content scrolls
// under the handle, which stays put. The board shrinks, and the Coach's log opens, by animations
// the scroll drives (a scroll listener where the browser has none), so nothing is laid out again
// while the sheet moves.
//
// At rest the content is cut to the sheet's height, so the scroller reaches no further than `d`: a
// swipe moves the sheet and never scrolls the text (the app may still scroll it to show a row).
// Once the sheet is up, the content scrolls on from there with the browser's momentum. A pull down
// from the content's top lowers the sheet, as the same scroller carries on below `d`. Let go between
// rest and up, the sheet goes where the finger was heading, by the browser's smooth scroll.
//
// The browser starts a scroll only once the finger has moved past its slop (15 px in Chromium,
// about 10 pt on iOS): until then the sheet follows the finger by a transform, which is folded
// into the scroll the moment the browser takes over.
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
/** A finger that moved less than this is still tapping: the sheet doesn't follow it yet. */
const JITTER = 3;
/** A first move this far from the touch: the browser held back the ones before (its slop). */
const SLOP_SEEN = 12;
/** A tap: down and up within this distance and time. */
const TAP_PX = 10;
const TAP_MS = 600;

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

const proto = Element.prototype;
const nativeScrollTop = Object.getOwnPropertyDescriptor(proto, 'scrollTop')!;
const nativeClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight')!;

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
  const handleEl = (): HTMLElement | null => scroller.querySelector<HTMLElement>(':scope > .sheet-handle');
  const coachEl = (): HTMLElement | null => scroller.querySelector<HTMLElement>(':scope > .coach');

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
    const coach = coachEl();
    write('--v2-rest', `${rest}px`);
    write('--v2-up', `${up}px`);
    write('--v2-d', `${d}px`);
    write('--v2-scale', String(scale));
    write('--v2-hh', `${handleEl()?.offsetHeight ?? 0}px`);
    write('--v2-coach-h', `${coach?.offsetHeight ?? 0}px`);
    // The content's height at rest: what fills the sheet up to the Coach once it is up, so the
    // scroller ends exactly at `d` while the content is cut.
    write('--v2-body-min', `${Math.max(0, height - up - chrome)}px`);
    // The Coach keeps its pulled-up size: at rest its log shows its last lines, as today's does,
    // with what is above them, and the "Put the answer away" row under them, clipped and covered
    // (sheet-v2.css). The scroll opens them.
    const wrap = coach?.querySelector<HTMLElement>('.log-wrap');
    const actions = coach?.querySelector<HTMLElement>(':scope > .log-actions');
    const gap = coach ? parseFloat(getComputedStyle(coach).rowGap) || 0 : 0;
    const logH = wrap?.offsetHeight ?? 0;
    const restLog = 3 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const shift = actions ? actions.offsetHeight + gap : 0;
    write('--v2-log-shift', `${shift}px`);
    write('--v2-coach-clip', `${Math.max(0, logH - restLog) + shift}px`);
    coach?.classList.toggle('v2-more', logH > restLog + 2);
    paint();
  };

  const scaleAt = (s: number): number => 1 - (1 - geo.scale) * (d > 0 ? Math.min(1, Math.max(0, s / d)) : 0);
  /** Without a scroll-driven animation: the board follows the scroll from a listener. */
  const paint = (): void => {
    frame = 0;
    if (scrollDriven) return;
    const s = scaleAt(scroller.scrollTop);
    col.style.transform = s < 1 ? `scale(${s})` : '';
  };

  // The content's own scroll, for the app (the Review brings an opened moment under its tabs): at
  // rest the content is a box only the app scrolls (overflow hidden); once whole, the scroller
  // carries it, so the content's scrollTop, scrollTo and rect stand for that part of the scroller.
  const visible = (): DOMRect => {
    const box = proto.getBoundingClientRect.call(body);
    const top = handleEl()?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top;
    const coach = coachEl();
    const bottom = coach ? coach.getBoundingClientRect().top : scroller.getBoundingClientRect().bottom;
    return new DOMRect(box.left, top, box.width, Math.max(0, bottom - top));
  };
  const contentTo = (top: number, smooth: boolean): void => {
    if (touching) return;
    const to = d + Math.max(0, top);
    if (smooth && !reduced()) glide(to);
    else scroller.scrollTop = to;
  };
  Object.defineProperties(body, {
    scrollTop: {
      configurable: true,
      get: () => (whole ? Math.max(0, scroller.scrollTop - d) : nativeScrollTop.get!.call(body)),
      set: (v: number) => (whole ? contentTo(v, false) : nativeScrollTop.set!.call(body, v)),
    },
    clientHeight: {
      configurable: true,
      get: () => (whole ? Math.round(visible().height) : nativeClientHeight.get!.call(body)),
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => (whole ? visible() : proto.getBoundingClientRect.call(body)),
    },
    scrollTo: {
      configurable: true,
      value: (a?: ScrollToOptions | number, b?: number) => {
        if (!whole) return typeof a === 'number' ? proto.scrollTo.call(body, a, b ?? 0) : proto.scrollTo.call(body, a);
        const top = typeof a === 'number' ? (b ?? 0) : (a?.top ?? body.scrollTop);
        contentTo(top, typeof a === 'object' && a?.behavior === 'smooth');
      },
    },
  });

  const setOpen = (value: boolean): void => {
    open = value;
    scroller.classList.toggle('v2-up', value);
    if (!value) setWhole(false);
  };
  const setWhole = (value: boolean): void => {
    if (whole === value) return;
    // Where the app scrolled the content while it was cut carries on in the scroller.
    const inner = value ? (nativeScrollTop.get!.call(body) as number) : 0;
    whole = value;
    body.classList.toggle('v2-open', value);
    if (inner > 0) scroller.scrollTop += inner;
  };
  /** A gesture in the sheet once it is up: the content opens for it. */
  const reach = (): void => {
    if (open) setWhole(true);
  };
  const setFull = (value: boolean): void => {
    if (sheet.full === value) return;
    own = true;
    sheet.full = value;
    own = false;
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
    setFull(up);
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
  let startX = 0;
  let startY = 0;
  /** The finger moved: a drag or a flick, not a tap. */
  let moved = false;
  /** The finger let go and the release waits for the next frame to see the browser's momentum. */
  let releasing = false;
  /**
   * A gesture that started with the content scrolled, let go with the sheet still up: what moves on
   * is the content's momentum, which stops at the content's top. Lowering the sheet takes a pull
   * from there (or the finger itself carrying on past the top).
   */
  let coastingContent = false;
  /** Until then the sheet may still be moving or coasting: a tap is turned into a click (see `tap`). */
  let busyUntil = 0;

  // Following the finger inside the browser's slop: `lead` px, by a transform, of the sheet
  // (`sheet`) or of the content alone (`content`), until the scroll takes over.
  let lead = 0;
  let leadKind: 'sheet' | 'content' | null = null;
  /** This gesture may lead: one finger, not on a box that takes typing, not sideways. */
  let mayLead = false;
  /** The browser scrolls for this gesture now: the finger's lead is in the scroll. */
  let scrolling = false;
  /** The gesture's first move is still to come. */
  let firstMove = false;
  /** The lead has been on screen: a frame was drawn with it. */
  let leadDrawn = false;
  let leadFrame = 0;
  const showLead = (): void => {
    const handle = handleEl();
    const y = lead ? `0 ${-lead}px` : '';
    body.style.translate = y;
    if (handle) handle.style.translate = leadKind === 'sheet' ? y : '';
    const s = scroller.scrollTop;
    col.style.scale = leadKind === 'sheet' && lead ? String(scaleAt(s + lead) / scaleAt(s)) : '';
  };
  /**
   * Hands the lead to the scroll: where the finger is, now the browser's. The scroll may already
   * hold part of the finger's travel (what it moved past the slop), so the scroll goes where the
   * finger is rather than adding the lead to it.
   */
  const fold = (): void => {
    if (!lead) return;
    const to = startScroll + lead;
    const shown = leadDrawn;
    lead = 0;
    leadKind = null;
    showLead();
    // A lead never drawn (the browser sent the finger's moves only as its scroll began, as Chromium
    // does: it holds back moves inside its slop) is left out: catching up would be a jump.
    if (shown) scroller.scrollTop = to;
  };

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
    if (touching) {
      // The browser has taken the finger over: the lead goes into the scroll.
      if (!scrolling && Math.abs(scroller.scrollTop - startScroll) > 0.5) {
        scrolling = true;
        fold();
      }
      // The finger raises the sheet: it is pulled up from now on, so the Coach is laid out for it
      // where the scroll still hides the difference (sheet-v2.css), not when it arrives.
      if (startScroll <= 1 && scroller.scrollTop > 1) setFull(true);
      return;
    }
    busyUntil = Math.max(busyUntil, performance.now() + 250);
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
  const touchMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!t) return;
    const dy = startY - t.clientY;
    if (Math.abs(dy) > 2 || Math.abs(t.clientX - startX) > 2) moved = true;
    if (e.touches.length !== 1) {
      mayLead = false;
      fold();
      return;
    }
    samples.push({ t: e.timeStamp, y: t.clientY });
    while (samples.length > 2 && e.timeStamp - samples[0]!.t > 100) samples.shift();
    // A browser that holds back the moves inside its slop (Chromium) shows itself by a first move
    // already past it: its scroll starts with it, and there is nothing to lead.
    if (firstMove) {
      firstMove = false;
      if (Math.abs(dy) >= SLOP_SEEN) mayLead = false;
    }
    if (scrolling || !mayLead) return;
    if (scroller.scrollTop !== startScroll) {
      scrolling = true;
      fold();
      return;
    }
    // Sideways is not the sheet's.
    if (Math.abs(t.clientX - startX) > Math.abs(dy) + 2) {
      mayLead = false;
      lead = 0;
      leadKind = null;
      showLead();
      return;
    }
    if (Math.abs(dy) < JITTER) return;
    if (startScroll <= 1 && dy > 0) {
      leadKind = 'sheet';
      lead = Math.min(dy, d);
      if (lead > 1) setFull(true);
    } else if (open && Math.abs(startScroll - d) <= 1 && dy < 0) {
      leadKind = 'sheet';
      lead = Math.max(dy, -d);
    } else if (whole && startScroll >= d - 1 && dy > 0) {
      leadKind = 'content';
      lead = Math.min(dy, scroller.scrollHeight - scroller.clientHeight - startScroll);
    } else if (whole && startScroll > d + 1 && dy < 0) {
      leadKind = 'content';
      lead = Math.max(dy, -(startScroll - d));
    } else return;
    showLead();
    if (!leadFrame && !leadDrawn) leadFrame = requestAnimationFrame(() => (leadFrame = requestAnimationFrame(() => ((leadDrawn = lead !== 0), (leadFrame = 0)))));
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
      lead = 0;
      leadKind = null;
      showLead();
    }
    if (e.cancelable) e.preventDefault();
  };
  const guarding = (on: boolean): void => {
    if (on) scroller.addEventListener('touchmove', guard, { passive: false });
    else scroller.removeEventListener('touchmove', guard);
  };

  /** The move a touch caught under way: a tap that starts nothing else lets it carry on. */
  let caught: number | null = null;
  const touchStart = (e: TouchEvent): void => {
    touching = true;
    clearTimeout(idle);
    // The finger takes over from a move under way, where it is drawn now.
    if (target !== null) {
      caught = target;
      scroller.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
    } else caught = null;
    target = null;
    releasing = false;
    coastingContent = false;
    retries = 0;
    reach();
    const t = e.touches[0];
    startX = t?.clientX ?? 0;
    startY = t?.clientY ?? 0;
    startScroll = scroller.scrollTop;
    samples = [{ t: e.timeStamp, y: startY }];
    moved = false;
    scrolling = false;
    lead = 0;
    leadKind = null;
    leadDrawn = false;
    firstMove = true;
    cancelAnimationFrame(leadFrame);
    leadFrame = 0;
    const on = e.target instanceof Element ? e.target : null;
    mayLead = e.touches.length === 1 && !on?.closest(`${FIELD}, .coach form`) && !closing;
    closing = false;
  };
  const touchEnd = (e: TouchEvent): void => {
    if (e.touches.length) return;
    touching = false;
    // A finger that never got past the browser's slop: its lead becomes the scroll, and the
    // release takes it from there.
    fold();
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
      busyUntil = performance.now() + 1200;
      releasing = true;
      requestAnimationFrame(() => release(lifted));
    } else if (!moved && caught !== null && target === null) glide(caught);
    caught = null;
    settleSoon();
  };

  // A tap while the sheet moves or the browser's momentum runs: the browser takes it to stop the
  // fling and sends no click. The tap goes to what the finger landed on all the same, and the
  // browser's own click, if it comes, is not a second one.
  let tap: { id: number; x: number; y: number; t: number; on: Element; busy: boolean } | null = null;
  /** The tapped element and until when the browser's late click on it is the same tap. */
  let suppress: { on: Element; until: number } | null = null;
  const tapDown = (e: PointerEvent): void => {
    const on = e.target instanceof Element ? e.target : null;
    // Anything in the frame: the sheet's buttons, the strip, the board's squares (a tap during the
    // browser's fling is swallowed wherever it lands).
    if (e.pointerType !== 'touch' || !on || !layout.contains(on)) return;
    tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, on, busy: target !== null || performance.now() < busyUntil };
  };
  const tapUp = (e: PointerEvent): void => {
    const was = tap;
    tap = null;
    if (!was?.busy || e.pointerId !== was.id) return;
    if (Math.hypot(e.clientX - was.x, e.clientY - was.y) > TAP_PX || e.timeStamp - was.t > TAP_MS) return;
    suppress = { on: was.on, until: performance.now() + 800 };
    const typing = was.on.closest<HTMLElement>(FIELD);
    if (typing) typing.focus();
    else (was.on as HTMLElement).click?.();
  };
  const tapCancel = (): void => {
    tap = null;
  };
  const clickOnce = (e: MouseEvent): void => {
    const was = suppress;
    if (!was || !e.isTrusted) return;
    suppress = null;
    const at = e.target instanceof Node ? e.target : null;
    if (performance.now() > was.until || !at || !(at === was.on || at.contains(was.on) || was.on.contains(at))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
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
  /** At rest a tap on the Coach's log, which shows its last lines, reads the rest: the sheet comes up. */
  const readAll = (e: MouseEvent): void => {
    if (open || !(e.target instanceof Element) || !e.target.closest('.coach .log-wrap') || e.target.closest('a, button, summary')) return;
    sheet.pullUp();
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
    const wrap = coachEl()?.querySelector('.log-wrap');
    if (wrap) sizes.observe(wrap);
  };
  // The Coach's rows come and go with `sheet.full` (Put the answer away), and its answer streams in:
  // measured as they change, before the frame is drawn, so the clip that shows its last lines at
  // rest is never a frame late.
  const coachRows = new MutationObserver(() => measure());
  const watchCoach = (): void => {
    coachRows.disconnect();
    const coach = coachEl();
    if (coach) coachRows.observe(coach, { childList: true, subtree: true, characterData: true });
  };
  const children = new MutationObserver(() => {
    watchChildren();
    watchCoach();
  });
  children.observe(scroller, { childList: true });
  watchChildren();
  watchCoach();
  measure();
  scroller.scrollTop = sheet.full ? d : 0;
  setOpen(sheet.full);
  if (sheet.full) setWhole(true);

  const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): (() => void) => {
    el.addEventListener(type, fn as EventListener, opts);
    return () => el.removeEventListener(type, fn as EventListener, opts);
  };
  const off = [
    on(scroller, 'scroll', onScroll, { passive: true }),
    on(scroller, 'scrollend', scrollEnd),
    on(scroller, 'touchstart', touchStart, { passive: true }),
    on(scroller, 'touchmove', touchMove, { passive: true }),
    on(scroller, 'touchend', touchEnd, { passive: true }),
    on(scroller, 'touchcancel', touchEnd, { passive: true }),
    on(scroller, 'focusin', focusIn),
    on(scroller, 'focusout', focusOut),
    on(scroller, 'submit', submit, { capture: true }),
    on(scroller, 'wheel', wheel, { passive: true }),
    on(scroller, 'click', readAll),
    on(layout, 'pointerdown', tapDown, { capture: true }),
    on(layout, 'pointerup', tapUp, { capture: true }),
    on(layout, 'pointercancel', tapCancel, { capture: true }),
    on(window, 'click', clickOnce, { capture: true }),
  ];

  return () => {
    stopListening();
    sizes.disconnect();
    children.disconnect();
    coachRows.disconnect();
    clearTimeout(idle);
    clearTimeout(quietFocusTimer);
    cancelAnimationFrame(frame);
    guarding(false);
    for (const stop of off) stop();
    for (const name of ['scrollTop', 'clientHeight', 'getBoundingClientRect', 'scrollTo']) delete (body as unknown as Record<string, unknown>)[name];
    body.classList.remove('v2-open');
    body.style.translate = '';
    scroller.classList.remove('v2-up');
    const handle = handleEl();
    if (handle) handle.style.translate = '';
    col.style.transform = '';
    col.style.scale = '';
    const left = (users.get(layout) ?? 1) - 1;
    users.set(layout, left);
    if (left === 0) {
      layout.classList.remove('v2-sheet', 'v2-sdt');
      for (const name of Object.keys(written)) layout.style.removeProperty(name);
    }
  };
}

export const v2: SheetDriver = {
  panel,
  /**
   * A tap toggles; a drag on it is the sheet's own scroll (touch-action in sheet-v2.css), which
   * ends in no click. A tap while the sheet still moves is made a click by the panel's hook.
   */
  handle: (sheet, node) => {
    const click = (): void => sheet.toggle();
    node.addEventListener('click', click);
    return () => node.removeEventListener('click', click);
  },
  /** A tap on the strip brings the board back: the sheet scrolls down to rest. */
  strip: (sheet, node) => {
    const click = (): void => {
      sheet.full = false;
    };
    node.addEventListener('click', click);
    return () => node.removeEventListener('click', click);
  },
  /** The frame needs nothing of its own: the panel's hook finds the board beside it. */
  frame: () => () => undefined,
};
