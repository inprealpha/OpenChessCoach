// PROTOTYPE (#80): version 3 of the phone's panel sheet, an overlay like Apple Maps'. The board keeps
// its size and never moves: the sheet is a card that slides up over the board's lower part, moved
// only by `transform`, following the finger exactly and settling with a critically damped spring
// seeded with the finger's speed (spring-v3.ts).
//
// Nothing is laid out again while the sheet moves. The card is laid out once, from the middle of the
// board to the foot of the screen, with the Coach at its pulled-up size; every position is a
// transform of that:
// - the card is translated down: to the board's foot at rest, and up only as far as its content
//   needs, so a short reply leaves most of the board in view and none leaves less than half;
// - the Coach is translated back up so its Ask row stays at the foot of the screen, and it shows
//   only its first two lines at rest (as today's sheet does), growing to its full size with the
//   sheet's progress rather than in one frame;
// - `sheet.full` (which the app re-renders on) changes only once the sheet has settled, never on the
//   frame it starts moving.
//
// At rest nothing scrolls (`touch-action: pan-x`, and `preventDefault` from the first move): any
// vertical drag moves the sheet. Up, the content scrolls natively; a drag down that starts with it at
// its top moves the sheet, and a scroll that reaches the top hands over to the sheet mid-gesture. A
// pull down on the board above the sheet peeks at the whole board and springs back, the text where
// it was; a tap there lets the sheet down. Its CSS is src/sheet-v3.css, under :root[data-sheet="v3"].
import { untrack } from 'svelte';
import type { Sheet } from '../sheet.svelte.ts';
import { bounded, endsUp, launchVelocity, progress, settled, SLOP, step, upDetent, velocity } from './spring-v3.ts';
import type { SheetDriver } from './types.ts';

const PHONE = '(max-width: 820px) and (min-height: 560px)';
/** Where a touch never drags: a box to type in. */
const TEXT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** How dark the board above the sheet gets with it up: a hint that a tap there brings it back. */
const DIM = 0.1;
/** The highest the sheet goes: this much of the board stays in view, from its top. */
const BOARD_KEPT = 0.5;
/** The Coach's log at rest, as today's sheet has it (CoachPanel's 3rem): two lines. */
const REST_LOG_REM = 3;

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Source = 'sheet' | 'strip';

interface Gesture {
  id: number;
  source: Source;
  x0: number;
  y0: number;
  lastY: number;
  /** pending: under the slop; sheet: the sheet follows; scroll: the content scrolls natively; ignore: not ours. */
  mode: 'pending' | 'sheet' | 'scroll' | 'ignore';
  /** The sheet was up (or on its way) when the finger came down. */
  wasUp: boolean;
  /** The content box under the finger, if it can scroll. */
  scroller: HTMLElement | null;
  /** The first move was taken from the browser (iOS decides on the first move). */
  prevented: boolean;
  /** Where the finger and the sheet were when the sheet took the drag over. */
  fromY: number;
  fromSheet: number;
  fromScroll: number;
  /** A native scroll that reached the content's top: the finger's position from which the sheet follows. */
  handover: number | null;
  samples: { t: number; y: number }[];
  /** Stops listening on the touched element itself. */
  release: () => void;
}

let current: Overlay | null = null;

class Overlay {
  readonly #sheet: Sheet;
  readonly #side: HTMLElement;
  readonly #body: HTMLElement;
  readonly #layout: HTMLElement;
  readonly #col: HTMLElement;
  readonly #scrim: HTMLElement;
  readonly #phone = typeof matchMedia === 'function' ? matchMedia(PHONE) : null;
  readonly #undo: (() => void)[] = [];
  /** The Coach and the parts of it that move on their own. */
  #coach: HTMLElement | null = null;
  #log: HTMLElement | null = null;
  #ask: HTMLElement[] = [];

  /** The sheet's offset down from the card's laid-out top (the middle of the board), px. */
  #y = 0;
  /** The detents: at rest (the board's foot) and up (as high as the content needs). */
  #rest = 0;
  #up = 0;
  /** How much taller the Coach is up than at rest, and how far into its log the latest reply starts. */
  #coachExtra = 0;
  #replyAt = 0;
  /** Where the sheet is going: what `sheet.full` will be once it settles. */
  #heading = false;
  /** This overlay is setting `sheet.full` itself: the listener has nothing to do. */
  #committing = false;
  /** The spring: its target, velocity (px/s) and last frame. */
  #target: number | null = null;
  #v = 0;
  #last = 0;
  #raf = 0;
  /** Scrolling the content back to its top while the sheet goes down: from where, and what was last set. */
  #unscroll: { from: number; y0: number; set: number } | null = null;
  #gesture: Gesture | null = null;
  /** Touch events already handled: each reaches both the touched element and the sheet. */
  readonly #seen = new WeakSet<Event>();
  /** A drag just ended: the click that may follow is not a tap. Until when, as an event time. */
  #noClickUntil = -1;
  /** The Ask box's focus pulled the sheet up: losing it lets the sheet down again. */
  #raisedByKeyboard = false;
  #blurTimer: ReturnType<typeof setTimeout> | undefined;
  /** Painted once: before that, a change jumps rather than animates (a screen opening). */
  #live = false;

  constructor(sheet: Sheet, side: HTMLElement, body: HTMLElement, layout: HTMLElement, col: HTMLElement) {
    this.#sheet = sheet;
    this.#side = side;
    this.#body = body;
    this.#layout = layout;
    this.#col = col;
    this.#scrim = document.createElement('div');
    this.#scrim.className = 'v3-scrim';
    this.#scrim.setAttribute('aria-hidden', 'true');
    layout.append(this.#scrim);
    this.#undo.push(() => this.#scrim.remove());

    this.#heading = sheet.full;
    this.#find();
    this.#measure();
    this.#y = this.#heading ? this.#up : this.#rest;
    this.#state();
    this.#mark();
    this.#render();
    const frame = requestAnimationFrame(() => (this.#live = true));
    this.#undo.push(() => cancelAnimationFrame(frame));

    // Sizes: the board, the frame, the content and the Coach. None changes while the sheet moves.
    const resize = new ResizeObserver(() => this.#resized());
    const observe = () => {
      resize.disconnect();
      for (const el of [col, layout, ...body.children, this.#coach, this.#coach?.querySelector('.log')]) if (el) resize.observe(el);
    };
    observe();
    this.#undo.push(() => resize.disconnect());
    // Parts that come and go: the content's sections, a Coach that comes later (a Puzzle's, once it is
    // solved), the Coach's own rows. Each is found and placed at once.
    const parts = new MutationObserver(() => {
      this.#find();
      observe();
      this.#resized();
    });
    parts.observe(side, { childList: true, subtree: true });
    this.#undo.push(() => parts.disconnect());
    const phone = () => this.#resized();
    this.#phone?.addEventListener('change', phone);
    this.#undo.push(() => this.#phone?.removeEventListener('change', phone));
    this.#undo.push(sheet.listen((full) => this.#changed(full)));

    this.#on(side, 'touchstart', (e) => this.touchStart(e as TouchEvent, 'sheet'), { passive: true });
    this.#on(side, 'touchmove', (e) => this.touchMove(e as TouchEvent), { passive: false });
    this.#on(side, 'touchend', (e) => this.touchEnd(e as TouchEvent), { passive: false });
    this.#on(side, 'touchcancel', (e) => this.touchEnd(e as TouchEvent), { passive: false });
    this.#on(side, 'wheel', (e) => this.#wheel(e as WheelEvent), { passive: false });
    this.#on(side, 'click', (e) => this.#click(e as MouseEvent));
    this.#on(side, 'focusin', (e) => this.#focusIn(e));
    this.#on(side, 'focusout', () => this.#focusOut());
    this.#on(side, 'submit', () => (this.#raisedByKeyboard = false));
    // The board above the sheet, up: a tap brings the board back, a pull down peeks at all of it.
    const scrim = this.#scrim;
    this.#on(scrim, 'click', (e) => {
      if (!this.justDragged(e)) this.lower();
    });
    this.#on(scrim, 'touchstart', (e) => this.touchStart(e as TouchEvent, 'strip'), { passive: true });
    this.#on(scrim, 'touchmove', (e) => this.touchMove(e as TouchEvent), { passive: false });
    this.#on(scrim, 'touchend', (e) => this.touchEnd(e as TouchEvent), { passive: false });
    this.#on(scrim, 'touchcancel', (e) => this.touchEnd(e as TouchEvent), { passive: false });
  }

  #on(node: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    node.addEventListener(type, fn, opts);
    this.#undo.push(() => node.removeEventListener(type, fn, opts));
  }

  destroy(): void {
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#blurTimer);
    for (const undo of this.#undo.splice(0)) undo();
    this.#gesture?.release();
    this.#gesture = null;
    this.#clear();
  }

  get #active(): boolean {
    return this.#sheet.on && (this.#phone?.matches ?? false);
  }

  #find(): void {
    this.#coach = this.#side.querySelector<HTMLElement>(':scope > .coach');
    this.#log = this.#coach?.querySelector<HTMLElement>(':scope > .log-wrap > .log') ?? null;
    this.#ask = [...(this.#coach?.querySelectorAll<HTMLElement>(':scope > .thumb-row, :scope > .chars-left') ?? [])];
  }

  /**
   * The board's height, the card's top, both detents and the Coach's sizes. Read when something was
   * resized, never while the sheet moves (transforms resize nothing).
   */
  #measure(): void {
    if (!this.#active) return;
    // Exact (fractional) heights, so the sheet at rest meets the board's foot to the sub-pixel.
    const col = this.#col.getBoundingClientRect();
    const board = this.#col.querySelector<HTMLElement>('.board')?.getBoundingClientRect();
    const keep = (board ? board.top - col.top : 0) + (board?.height ?? col.height) * BOARD_KEPT;
    const band = Math.round(Math.max(48, Math.min(keep, col.height)));
    if (this.#layout.style.getPropertyValue('--v3-band') !== `${band}px`) this.#layout.style.setProperty('--v3-band', `${band}px`);
    this.#rest = Math.max(0, col.height - band);

    // The Coach: up, its log takes its full size; at rest, two lines of it, from the latest reply's start.
    const coach = this.#coach;
    const log = coach?.querySelector<HTMLElement>('.log');
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const logH = log && log.offsetParent ? log.offsetHeight : 0;
    this.#coachExtra = Math.min(this.#rest, Math.max(0, logH - REST_LOG_REM * rem));
    if (log && this.#coachExtra > 0) {
      const entries = log.querySelectorAll<HTMLElement>(':scope > .entry');
      const last = entries[entries.length - 1];
      const at = last ? last.getBoundingClientRect().top - log.getBoundingClientRect().top : 0;
      this.#replyAt = Math.max(0, Math.min(this.#coachExtra, at));
    } else this.#replyAt = 0;
    // What focus may scroll the content to at rest: above the Coach, not behind it.
    const hidden = Math.max(0, this.#rest - this.#coachExtra);
    if (this.#layout.style.getPropertyValue('--v3-rest') !== `${hidden}px`) this.#layout.style.setProperty('--v3-rest', `${hidden}px`);

    // Up: as high as the content and the whole Coach need, no higher.
    const card = this.#side.offsetHeight;
    let bottom = 0;
    for (const child of this.#body.children) {
      if (!(child instanceof HTMLElement) || child.offsetParent === null) continue;
      bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
    }
    const pad = parseFloat(getComputedStyle(this.#body).paddingBottom) || 0;
    const need = this.#body.offsetTop + bottom + pad + 0.6 * rem + (coach?.offsetHeight ?? 0);
    this.#up = upDetent(card, need, this.#rest);
    this.#layout.dataset.v3Up = this.#up.toFixed(3);
  }

  #resized(): void {
    if (!this.#active) {
      this.#clear();
      return;
    }
    this.#measure();
    // Back on a phone held upright (it only writes what changed).
    this.#state();
    if (this.#gesture?.mode === 'sheet' || (this.#gesture?.mode === 'scroll' && this.#gesture.handover !== null)) return;
    const target = this.#heading ? this.#up : this.#rest;
    if (this.#target !== null) this.#target = target;
    else if (this.#live && !reduced() && Math.abs(this.#y - target) > 0.5) this.#animateTo(target, 0);
    else this.#y = target;
    this.#render();
  }

  /** Back to the plain panel: off a phone held upright. */
  #clear(): void {
    this.#side.style.transform = '';
    for (const el of [this.#coach, this.#log, ...this.#ask]) if (el) el.style.transform = '';
    this.#scrim.style.opacity = '0';
    this.#side.style.touchAction = '';
    this.#body.style.overscrollBehaviorY = '';
    this.#body.style.scrollPaddingBottom = '';
    this.#scrim.style.pointerEvents = '';
    this.#layout.style.removeProperty('--v3-band');
    this.#layout.style.removeProperty('--v3-rest');
    this.#rest = 0;
    this.#up = 0;
  }

  /**
   * Where the sheet is heading: what touches do (scroll or drag), what focus may scroll to, and what
   * the board above the sheet does with a tap. Inline styles on those few elements, not an attribute
   * the screen's selectors would have to match again (its `:has()` rules make that a long frame).
   */
  #state(): void {
    const up = this.#heading;
    const set = (el: HTMLElement | null, prop: 'touchAction' | 'overscrollBehaviorY' | 'scrollPaddingBottom' | 'pointerEvents', value: string) => {
      if (el && el.style[prop] !== value) el.style[prop] = value;
    };
    // At rest nothing scrolls: a vertical drag is the sheet's (sideways ones are left alone). Up, the
    // content scrolls, and its top doesn't bounce: a pull down there moves the sheet instead.
    set(this.#side, 'touchAction', up ? '' : 'pan-x');
    set(this.#body, 'overscrollBehaviorY', up ? 'none' : '');
    // At rest, focus that scrolls the content to show a control keeps it above the Coach, not behind it.
    set(this.#body, 'scrollPaddingBottom', up ? '' : 'var(--v3-rest, 0px)');
    // Up (and on its way), the board above the sheet is the dim's: a tap brings the board back, a pull
    // peeks at it. One element with nothing in it, not the board, whose restyling would be a long frame.
    // On its way down the board takes its taps again at once.
    set(this.#scrim, 'pointerEvents', up ? 'auto' : 'none');
  }

  /** The settled state, for anyone reading the page (the journeys): set when nothing moves. */
  #mark(): void {
    const s = this.#heading ? 'up' : 'rest';
    if (this.#side.dataset.v3 !== s) this.#side.dataset.v3 = s;
  }

  /** Transforms and the scrim's opacity: nothing that lays the page out again. */
  #render(): void {
    if (!this.#active) return;
    if (!this.#coach?.isConnected) this.#find();
    const y = this.#y;
    const p = progress(y, this.#rest, this.#up);
    // The Coach, laid out at its up size, shows only two lines at rest: moved down by what it has
    // extra, its Ask row moved back to the foot of the screen, and its log moved so the latest reply's
    // start is in the window. All three follow the sheet's progress.
    const extra = this.#coachExtra * (1 - p);
    this.#side.style.transform = `translate3d(0, ${y}px, 0)`;
    if (this.#coach) this.#coach.style.transform = `translate3d(0, ${extra - y}px, 0)`;
    if (this.#log) this.#log.style.transform = this.#replyAt ? `translate3d(0, ${-this.#replyAt * (1 - p)}px, 0)` : '';
    for (const el of this.#ask) el.style.transform = extra ? `translate3d(0, ${-extra}px, 0)` : '';
    this.#scrim.style.opacity = (p * DIM).toFixed(3);
  }

  /** `sheet.full` changed. By this overlay once settled: nothing to do. By the app: the spring goes there. */
  #changed(full: boolean): void {
    if (this.#committing) return;
    if (!full) this.#raisedByKeyboard = false;
    this.#heading = full;
    if (this.#gesture?.mode !== 'sheet') this.#animateTo(full ? this.#up : this.#rest, 0);
    this.#state();
  }

  /** The sheet goes up or down by the spring; the app hears of it once it has settled. */
  #go(up: boolean, v: number): void {
    if (!up) this.#raisedByKeyboard = false;
    this.#heading = up;
    // Reads first (the spring's start reads the content's scroll), then the attributes: no style is
    // worked out twice in the frame the sheet starts moving.
    this.#animateTo(up ? this.#up : this.#rest, v);
    this.#state();
  }

  /** Settled: `sheet.full` follows, and the app re-renders now that nothing moves. */
  #commit(): void {
    this.#mark();
    if (this.#sheet.full === this.#heading) return;
    this.#committing = true;
    try {
      this.#sheet.full = this.#heading;
    } finally {
      this.#committing = false;
    }
  }

  #animateTo(target: number, v: number): void {
    // Going down: the content scrolls back to its top on the way, as Maps does, unless the app scrolls it.
    this.#unscroll = target === this.#rest && this.#body.scrollTop > 0 ? { from: this.#body.scrollTop, y0: this.#y, set: this.#body.scrollTop } : null;
    if (!this.#live || reduced() || !this.#active) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
      this.#target = null;
      this.#y = target;
      if (this.#unscroll) this.#body.scrollTop = 0;
      this.#unscroll = null;
      this.#render();
      this.#commit();
      return;
    }
    this.#target = target;
    this.#v = launchVelocity(this.#y - target, v);
    this.#last = performance.now();
    // Whatever frame was waiting (the spring's next step, or a settled spring's commit) gives way.
    cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #tick = (now: number): void => {
    this.#raf = 0;
    const target = this.#target;
    if (target === null) return;
    let dt = (now - this.#last) / 1000;
    // A frame stamped before the release that started it still moves the sheet a frame's worth.
    if (dt <= 0.001) dt = 1 / 60;
    this.#last = now;
    // Solved exactly for any step: a late frame lands where the sheet should be by now.
    const s = step({ x: this.#y - target, v: this.#v }, dt);
    this.#y = target + s.x;
    this.#v = s.v;
    const done = settled(s);
    if (done) {
      this.#y = target;
      this.#v = 0;
      this.#target = null;
    }
    this.#syncScroll();
    this.#render();
    if (!done) this.#raf = requestAnimationFrame(this.#tick);
    // The app's re-render for the new state waits for a frame with nothing moving.
    else this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      if (this.#target === null && !this.#gesture) this.#commit();
    });
  };

  #syncScroll(): void {
    const u = this.#unscroll;
    if (!u) return;
    // The app scrolled the content itself (the Review shows an opened moment): it keeps that.
    if (Math.abs(this.#body.scrollTop - u.set) > 1) {
      this.#unscroll = null;
      return;
    }
    const span = this.#rest - u.y0;
    const done = span <= 0 ? 1 : Math.min(1, Math.max(0, (this.#y - u.y0) / span));
    u.set = Math.round(u.from * (1 - done));
    this.#body.scrollTop = u.set;
    if (done >= 1) this.#unscroll = null;
  }

  #stopSpring(): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#target = null;
    this.#unscroll = null;
  }

  // Gestures. Touch events, not pointer events: once the browser starts a native scroll it cancels
  // a pointer, but keeps sending touches, so a scroll that reaches the top can hand over.

  touchStart(e: TouchEvent, source: Source): void {
    if (!this.#active || this.#seen.has(e)) return;
    this.#seen.add(e);
    // A second finger: once the first is dragging the sheet it keeps it; before that, two fingers
    // are a pinch or a two-finger pan, not the sheet's.
    if (e.touches.length > 1) {
      if (this.#gesture?.mode === 'pending') this.#gesture.mode = 'ignore';
      return;
    }
    // One finger down and a gesture left over: its end never came (its element went away).
    this.#gesture?.release();
    this.#gesture = null;
    const t = e.changedTouches[0];
    if (!t) return;
    const target = e.target instanceof Element ? e.target : null;
    // The rest of the touch goes to the element it started on, even if it leaves the page (a button
    // a tap re-renders), so the gesture always hears its end. The sheet hears it too, once.
    const move = (m: Event) => this.touchMove(m as TouchEvent);
    const end = (m: Event) => this.touchEnd(m as TouchEvent);
    target?.addEventListener('touchmove', move, { passive: false });
    target?.addEventListener('touchend', end, { passive: false });
    target?.addEventListener('touchcancel', end, { passive: false });
    const release = () => {
      target?.removeEventListener('touchmove', move);
      target?.removeEventListener('touchend', end);
      target?.removeEventListener('touchcancel', end);
    };
    const text = Boolean(target?.closest(TEXT));
    this.#gesture = {
      id: t.identifier,
      source,
      x0: t.clientX,
      y0: t.clientY,
      lastY: t.clientY,
      mode: text ? 'ignore' : 'pending',
      wasUp: this.#heading,
      scroller: source === 'sheet' && target ? this.#scrollerAt(target) : null,
      prevented: false,
      fromY: 0,
      fromSheet: 0,
      fromScroll: 0,
      handover: null,
      samples: [{ t: e.timeStamp, y: t.clientY }],
      release,
    };
  }

  /** The box under the finger that scrolls: the content, or the Coach's log when it has more to show. */
  #scrollerAt(target: Element): HTMLElement | null {
    for (let el: Element | null = target; el && el !== this.#side; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      if (el === this.#body) return el;
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  }

  #touch(e: TouchEvent): Touch | null {
    const g = this.#gesture;
    if (!g) return null;
    for (const t of e.touches) if (t.identifier === g.id) return t;
    return null;
  }

  touchMove(e: TouchEvent): void {
    if (this.#seen.has(e)) return;
    this.#seen.add(e);
    const g = this.#gesture;
    const t = this.#touch(e);
    if (!g || !t) return;
    const prevY = g.lastY;
    const y = t.clientY;
    g.lastY = y;
    const dx = t.clientX - g.x0;
    const dy = y - g.y0;
    if (g.mode === 'ignore') {
      if (g.prevented && e.cancelable) e.preventDefault();
      return;
    }
    const canScroll = g.wasUp && g.scroller !== null;

    if (g.mode === 'pending') {
      // At rest nothing scrolls, and up the content keeps the drag unless it is at its top and the
      // finger goes down: decided on the first move, the only one iOS lets a page take.
      const vertical = Math.abs(dy) >= Math.abs(dx);
      const ours = !canScroll || (dy > 0 && g.scroller!.scrollTop <= 0);
      if (!g.prevented && g.samples.length === 1 && !ours) {
        g.mode = 'scroll';
      } else if (vertical && ours && e.cancelable) {
        e.preventDefault();
        g.prevented = true;
      }
      if (g.mode === 'pending') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) {
          g.samples.push({ t: e.timeStamp, y });
          return;
        }
        if (!vertical) {
          // Sideways: not the sheet's.
          g.mode = 'ignore';
          return;
        }
        if (this.#keyboardDown(dy, e)) return;
        this.#claim(g, y);
      }
    }

    if (g.mode === 'scroll') {
      // The content scrolls itself. Once it reaches its top with the finger still going down, the
      // sheet follows the finger from there.
      const s = g.scroller!;
      if (g.handover === null && y > prevY && s.scrollTop <= 0) {
        if (this.#keyboardDown(1, e)) return;
        g.handover = y;
        g.fromSheet = this.#y;
        this.#stopSpring();
      }
      if (g.handover !== null) {
        const raw = y - g.handover;
        if (raw < 0) {
          g.handover = null;
          this.#y = g.fromSheet;
        } else {
          this.#y = bounded(g.fromSheet + raw, this.#rest, this.#up);
          if (e.cancelable) e.preventDefault();
        }
        g.samples.push({ t: e.timeStamp, y });
        this.#render();
      }
      return;
    }

    if (g.mode === 'sheet') {
      if (e.cancelable) e.preventDefault();
      g.samples.push({ t: e.timeStamp, y });
      if (g.samples.length > 12) g.samples.shift();
      let raw = g.fromSheet + (y - g.fromY);
      // Up past the top detent, the content takes the rest of the drag, as it would have scrolled.
      const s = g.source === 'sheet' ? (g.scroller ?? this.#body) : null;
      if (raw < this.#up && s) {
        const room = s.scrollHeight - s.clientHeight;
        const want = g.fromScroll + (this.#up - raw);
        if (room > 0) {
          s.scrollTop = Math.min(room, want);
          raw = want > room ? this.#up - (want - room) : this.#up;
        }
      } else if (s && s.scrollTop !== g.fromScroll && raw >= this.#up) {
        s.scrollTop = g.fromScroll;
      }
      this.#y = bounded(raw, this.#rest, this.#up);
      this.#render();
    }
  }

  /** The finger takes the sheet: from where it is now, so nothing jumps. */
  #claim(g: Gesture, y: number): void {
    this.#stopSpring();
    this.#raisedByKeyboard = false;
    g.mode = 'sheet';
    g.fromY = y;
    g.fromSheet = this.#y;
    const s = g.scroller ?? this.#body;
    g.fromScroll = s.scrollTop;
    g.samples = g.samples.slice(-1);
  }

  /** With the keyboard up, a drag down closes it, and lets the sheet down if the Ask box brought it up. */
  #keyboardDown(dy: number, e: TouchEvent): boolean {
    const g = this.#gesture;
    const focused = document.activeElement;
    if (!g || dy <= 0 || !(focused instanceof HTMLElement) || !focused.matches(TEXT) || !this.#side.contains(focused)) return false;
    const lower = this.#raisedByKeyboard;
    focused.blur();
    g.mode = 'ignore';
    g.prevented = true;
    if (e.cancelable) e.preventDefault();
    if (lower) {
      clearTimeout(this.#blurTimer);
      this.#go(false, 0);
    }
    return true;
  }

  touchEnd(e: TouchEvent): void {
    if (this.#seen.has(e)) return;
    this.#seen.add(e);
    const g = this.#gesture;
    if (!g) return;
    let ours = false;
    for (const t of e.changedTouches) if (t.identifier === g.id) ours = true;
    if (!ours) return;
    this.#gesture = null;
    g.release();
    const dragged = g.mode === 'sheet' || (g.mode === 'scroll' && g.handover !== null);
    if (!dragged) {
      if (g.mode === 'ignore' && g.prevented && e.cancelable) e.preventDefault();
      // A spring that waited for the finger to commit its state can do it now.
      if (this.#target === null && !this.#raf) this.#commit();
      return;
    }
    // A drag is not a tap: no click on whatever is under the finger. Cancelling the touch's end does
    // that; a click arriving at once anyway is dropped too, but not a tap a moment later.
    if (e.cancelable) e.preventDefault();
    this.#noClickUntil = e.timeStamp + 60;
    const v = e.type === 'touchcancel' ? 0 : velocity(g.samples, e.timeStamp);
    // A pull on the board above the sheet is a peek: the sheet springs back up, the text where it was.
    if (g.source === 'strip') {
      this.#go(true, v);
      return;
    }
    // Decided on the finger's whole travel, the slop included: where the sheet would be had it moved
    // from the first touch (a browser may not report the moves under the slop at all).
    const travelled = g.mode === 'sheet' ? Math.max(this.#up, Math.min(this.#rest, g.fromSheet + (g.lastY - g.y0))) : this.#y;
    this.#go(endsUp(travelled, v, this.#rest, g.wasUp, this.#up), v);
  }

  /** A click that ends a drag is not a tap. */
  justDragged(e: Event): boolean {
    return e.timeStamp < this.#noClickUntil;
  }

  /** The handle's tap: the other way from where the sheet is heading. */
  toggle(): void {
    this.#go(!this.#heading, 0);
  }

  /** The band's tap: the board back. */
  lower(): void {
    this.#go(false, 0);
  }

  /** The handle's own mouse drag (a touch on it is the sheet's). */
  mouseDown(e: PointerEvent, node: HTMLElement): void {
    if (!this.#active || e.pointerType !== 'mouse' || e.button !== 0) return;
    const wasUp = this.#heading;
    const y0 = e.clientY;
    let dragging = false;
    let fromSheet = 0;
    const samples: { t: number; y: number }[] = [];
    const move = (m: PointerEvent) => {
      const dy = m.clientY - y0;
      if (!dragging) {
        if (Math.abs(dy) < SLOP) return;
        dragging = true;
        this.#stopSpring();
        fromSheet = this.#y - dy;
        node.setPointerCapture?.(m.pointerId);
      }
      samples.push({ t: m.timeStamp, y: m.clientY });
      this.#y = bounded(fromSheet + dy, this.#rest, this.#up);
      this.#render();
    };
    const up = (u: PointerEvent) => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      if (!dragging) return;
      // The mouse's click follows its release.
      this.#noClickUntil = u.timeStamp + 400;
      const v = velocity(samples, u.timeStamp);
      this.#go(endsUp(this.#y, v, this.#rest, wasUp, this.#up), v);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  #wheel(e: WheelEvent): void {
    if (!this.#active || this.#heading) return;
    // At rest the content doesn't scroll: a wheel turned down pulls the sheet up instead.
    e.preventDefault();
    if (e.deltaY > 0) this.#go(true, 0);
  }

  /** At rest the Coach's two lines are cut: a tap on them reads the rest, as Read all does today. */
  #click(e: MouseEvent): void {
    if (!this.#active || this.#heading || !(e.target instanceof Element)) return;
    if (!e.target.closest('.coach .log') || e.target.closest('a, button, summary, input, details')) return;
    this.#go(true, 0);
  }

  #focusIn(e: Event): void {
    clearTimeout(this.#blurTimer);
    const t = e.target;
    if (!this.#active || !(t instanceof HTMLElement) || !t.matches('.coach input')) return;
    // The keyboard comes up for the Ask box: the sheet comes up with it, over the board.
    if (!this.#heading) {
      this.#raisedByKeyboard = true;
      this.#go(true, 0);
    }
  }

  #focusOut(): void {
    if (!this.#raisedByKeyboard) return;
    clearTimeout(this.#blurTimer);
    // A moment later, as today's board does, so the tap that took the focus away lands where it was aimed.
    this.#blurTimer = setTimeout(() => {
      const focused = document.activeElement;
      if (!this.#raisedByKeyboard || (focused instanceof HTMLElement && focused.matches('.coach input'))) return;
      this.#go(false, 0);
    }, 400);
  }
}

export const v3: SheetDriver = {
  // Untracked: an attachment that read `sheet.full` would be torn down and made again on every change.
  panel: (sheet, node) =>
    untrack(() => {
      const side = node.closest<HTMLElement>('.side.panel');
      const layout = node.closest<HTMLElement>('.board-layout');
      const col = layout?.querySelector<HTMLElement>(':scope > .board-col');
      if (!side || !layout || !col) return () => undefined;
      const overlay = new Overlay(sheet, side, node, layout, col);
      current = overlay;
      return () => {
        overlay.destroy();
        if (current === overlay) current = null;
      };
    }),
  handle: (sheet, node) => {
    const click = (e: MouseEvent) => {
      // A keyboard's Enter or Space (no pointer, detail 0) always toggles.
      if (e.detail !== 0 && current?.justDragged(e)) return;
      if (current) current.toggle();
      else sheet.toggle();
    };
    const down = (e: PointerEvent) => current?.mouseDown(e, node);
    node.addEventListener('click', click);
    node.addEventListener('pointerdown', down);
    return () => {
      node.removeEventListener('click', click);
      node.removeEventListener('pointerdown', down);
    };
  },
  strip: (sheet, node) => {
    // The board above the sheet: a tap brings the board back, a pull down peeks at all of it.
    const click = (e: MouseEvent) => {
      if (current?.justDragged(e)) return;
      if (current) current.lower();
      else sheet.full = false;
    };
    const start = (e: TouchEvent) => current?.touchStart(e, 'strip');
    const move = (e: TouchEvent) => current?.touchMove(e);
    const end = (e: TouchEvent) => current?.touchEnd(e);
    node.addEventListener('click', click);
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end, { passive: false });
    node.addEventListener('touchcancel', end, { passive: false });
    return () => {
      node.removeEventListener('click', click);
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
    };
  },
  frame: () => () => undefined,
};
