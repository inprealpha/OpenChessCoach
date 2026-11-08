// PROTOTYPE (#80): version 3 of the phone's panel sheet, an overlay like Apple Maps'. The board keeps
// its size and never moves: the sheet is a card that slides up over the board's lower part, moved
// only by `transform`, following the finger exactly and settling with a critically damped spring
// seeded with the finger's speed (spring-v3.ts). Up, it leaves a band of the board, dimmed, that a
// tap or a drag down brings back.
//
// The card is laid out once at its "up" size, so nothing is laid out again while it moves: at rest it
// is translated down by `rest` px, and the Coach's Ask box at its foot is translated back up by the
// same amount, so it stays docked at the foot of the screen in every position. The content shows
// above the Ask box at rest as it does today, and fades out where it is cut.
//
// At rest nothing scrolls (`touch-action: pan-x`, and `preventDefault` from the first move): any
// vertical drag moves the sheet. Up, the content scrolls natively; a drag down that starts with it at
// its top moves the sheet, and a scroll that reaches the top hands over to the sheet mid-gesture.
// Its CSS is src/sheet-v3.css, scoped under :root[data-sheet="v3"].
import { untrack } from 'svelte';
import type { Sheet } from '../sheet.svelte.ts';
import { bounded, endsUp, launchVelocity, settled, SLOP, step, velocity } from './spring-v3.ts';
import type { SheetDriver } from './types.ts';

const PHONE = '(max-width: 820px) and (min-height: 560px)';
/** Where a touch never drags: a box to type in. */
const TEXT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** How dark the covered board gets with the sheet up. */
const DIM = 0.25;
/** The band of the board left showing above the sheet when it is up: a quarter of the board, in bounds. */
const BAND = { share: 0.25, min: 64, max: 140 };

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Source = 'sheet' | 'strip' | 'handle';

interface Gesture {
  id: number;
  source: Source;
  x0: number;
  y0: number;
  lastY: number;
  /** pending: under the slop; sheet: the sheet follows; scroll: the content scrolls natively; ignore: not ours. */
  mode: 'pending' | 'sheet' | 'scroll' | 'ignore';
  /** The sheet was up when the finger came down. */
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
  #coach: HTMLElement | null = null;

  /** The sheet's offset down from its "up" detent, px. */
  #y = 0;
  /** The offset at rest: the board's height less the band. */
  #rest = 0;
  #band = 0;
  /** The spring: its target, velocity (px/s) and last frame. */
  #target: number | null = null;
  #v = 0;
  #last = 0;
  #raf = 0;
  /** The velocity the next change of `sheet.full` starts the spring with: the finger's, on release. */
  #releaseV = 0;
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

    this.#measure();
    this.#y = sheet.full ? 0 : this.#rest;
    this.#state(sheet.full);
    this.#render();
    const frame = requestAnimationFrame(() => (this.#live = true));
    this.#undo.push(() => cancelAnimationFrame(frame));

    const resize = new ResizeObserver(() => this.#resized());
    resize.observe(col);
    resize.observe(layout);
    this.#undo.push(() => resize.disconnect());
    // A Coach that comes later (a Puzzle's, once it is solved) is docked at the screen's foot at once.
    const children = new MutationObserver(() => this.#render());
    children.observe(side, { childList: true });
    this.#undo.push(() => children.disconnect());
    const phone = () => this.#resized();
    this.#phone?.addEventListener('change', phone);
    this.#undo.push(() => this.#phone?.removeEventListener('change', phone));
    this.#undo.push(sheet.listen((full) => this.#changed(full)));

    this.#on(side, 'touchstart', (e) => this.touchStart(e as TouchEvent, 'sheet'), { passive: true });
    this.#on(side, 'touchmove', (e) => this.touchMove(e as TouchEvent), { passive: false });
    this.#on(side, 'touchend', (e) => this.touchEnd(e as TouchEvent), { passive: false });
    this.#on(side, 'touchcancel', (e) => this.touchEnd(e as TouchEvent), { passive: false });
    this.#on(side, 'wheel', (e) => this.#wheel(e as WheelEvent), { passive: false });
    this.#on(side, 'focusin', (e) => this.#focusIn(e));
    this.#on(side, 'focusout', () => this.#focusOut());
    this.#on(side, 'submit', () => (this.#raisedByKeyboard = false));
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

  /** The board's height and the band: read only when something was resized, never while moving. */
  #measure(): void {
    if (!this.#active) return;
    // Exact (fractional) heights, so the sheet at rest meets the board's foot to the sub-pixel.
    const col = this.#col.getBoundingClientRect();
    const colH = col.height;
    const board = this.#col.querySelector<HTMLElement>('.board')?.getBoundingClientRect();
    const raw = (board ? board.top - col.top : 0) + (board?.height ?? colH) * BAND.share;
    const band = Math.round(Math.max(BAND.min, Math.min(BAND.max, raw, colH)));
    if (band !== this.#band) {
      this.#band = band;
      this.#layout.style.setProperty('--v3-band', `${band}px`);
    }
    const rest = Math.max(0, colH - band);
    if (rest !== this.#rest) {
      this.#rest = rest;
      this.#layout.style.setProperty('--v3-rest', `${rest}px`);
    }
  }

  #resized(): void {
    if (!this.#active) {
      this.#clear();
      return;
    }
    this.#measure();
    if (this.#gesture?.mode === 'sheet') return;
    if (this.#target !== null) this.#target = this.#sheet.full ? 0 : this.#rest;
    else this.#y = this.#sheet.full ? 0 : this.#rest;
    this.#render();
  }

  /** Back to the plain panel: off a phone held upright. */
  #clear(): void {
    this.#side.style.transform = '';
    if (this.#coach) this.#coach.style.transform = '';
    this.#scrim.style.opacity = '0';
    this.#layout.style.removeProperty('--v3-band');
    this.#layout.style.removeProperty('--v3-rest');
    this.#band = 0;
    this.#rest = 0;
  }

  /** The state the sheet is headed for: what touches do (scroll or drag) and what focus may scroll. */
  #state(full: boolean): void {
    this.#side.dataset.v3 = full ? 'up' : 'rest';
  }

  /** Transforms and the scrim's opacity: nothing that lays the page out again. */
  #render(): void {
    if (!this.#active) return;
    if (!this.#coach?.isConnected) this.#coach = this.#side.querySelector<HTMLElement>(':scope > .coach');
    const y = this.#y;
    this.#side.style.transform = `translate3d(0, ${y}px, 0)`;
    if (this.#coach) this.#coach.style.transform = `translate3d(0, ${-y}px, 0)`;
    const up = this.#rest > 0 ? Math.min(1, Math.max(0, 1 - y / this.#rest)) : 0;
    this.#scrim.style.opacity = (up * DIM).toFixed(3);
  }

  /** `sheet.full` changed, by a gesture, a tap or the app itself: the spring takes the sheet there. */
  #changed(full: boolean): void {
    if (!full) this.#raisedByKeyboard = false;
    this.#state(full);
    const v = this.#releaseV;
    this.#releaseV = 0;
    if (this.#gesture?.mode === 'sheet') return;
    this.#animateTo(full ? 0 : this.#rest, v);
  }

  #animateTo(target: number, v: number): void {
    // No measuring here: the ResizeObserver keeps `rest` current, and retargets a running spring.
    if (target !== 0) target = this.#rest;
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
      return;
    }
    this.#target = target;
    this.#v = launchVelocity(this.#y - target, v);
    this.#last = performance.now();
    if (!this.#raf) this.#raf = requestAnimationFrame(this.#tick);
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
    const wasUp = this.#sheet.full;
    const text = Boolean(target?.closest(TEXT));
    this.#gesture = {
      id: t.identifier,
      source,
      x0: t.clientX,
      y0: t.clientY,
      lastY: t.clientY,
      mode: text ? 'ignore' : 'pending',
      wasUp,
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
        this.#stopSpring();
      }
      if (g.handover !== null) {
        const raw = y - g.handover;
        if (raw < 0) {
          g.handover = null;
          this.#y = 0;
        } else {
          this.#y = bounded(raw, this.#rest);
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
      if (raw < 0 && s) {
        const room = s.scrollHeight - s.clientHeight;
        const want = g.fromScroll - raw;
        s.scrollTop = Math.min(room, want);
        raw = want > room ? -(want - room) : 0;
      } else if (s && s.scrollTop !== g.fromScroll && raw >= 0) {
        s.scrollTop = g.fromScroll;
      }
      this.#y = bounded(raw, this.#rest);
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
    focused.blur();
    g.mode = 'ignore';
    g.prevented = true;
    if (e.cancelable) e.preventDefault();
    if (this.#raisedByKeyboard) {
      clearTimeout(this.#blurTimer);
      this.#raisedByKeyboard = false;
      this.#sheet.full = false;
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
      return;
    }
    // A drag is not a tap: no click on whatever is under the finger. Cancelling the touch's end does
    // that; a click arriving at once anyway is dropped too, but not a tap a moment later.
    if (e.cancelable) e.preventDefault();
    this.#noClickUntil = e.timeStamp + 60;
    const v = e.type === 'touchcancel' ? 0 : velocity(g.samples, e.timeStamp);
    // Decided on the finger's whole travel, the slop included: where the sheet would be had it moved
    // from the first touch (a browser may not report the moves under the slop at all).
    const travelled = g.mode === 'sheet' ? Math.max(0, Math.min(this.#rest, g.fromSheet + (g.lastY - g.y0))) : this.#y;
    this.#release(v, g.wasUp, travelled);
  }

  /** Let go: the spring takes the sheet where it is heading. */
  #release(v: number, wasUp: boolean, at = this.#y): void {
    const up = endsUp(at, v, this.#rest, wasUp);
    if (this.#sheet.full !== up) {
      this.#releaseV = v;
      this.#sheet.full = up;
    } else this.#animateTo(up ? 0 : this.#rest, v);
  }

  /** The handle's own mouse drag (a touch on it is the sheet's). */
  mouseDown(e: PointerEvent, node: HTMLElement): void {
    if (!this.#active || e.pointerType !== 'mouse' || e.button !== 0) return;
    const wasUp = this.#sheet.full;
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
      this.#y = bounded(fromSheet + dy, this.#rest);
      this.#render();
    };
    const up = (u: PointerEvent) => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      if (!dragging) return;
      // The mouse's click follows its release.
      this.#noClickUntil = u.timeStamp + 400;
      this.#release(velocity(samples, u.timeStamp), wasUp);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  /** A click that ends a drag is not a tap. */
  justDragged(e: Event): boolean {
    return e.timeStamp < this.#noClickUntil;
  }

  #wheel(e: WheelEvent): void {
    if (!this.#active || this.#sheet.full) return;
    // At rest the content doesn't scroll: a wheel turned down pulls the sheet up instead.
    e.preventDefault();
    if (e.deltaY > 0) this.#sheet.pullUp();
  }

  #focusIn(e: Event): void {
    clearTimeout(this.#blurTimer);
    const t = e.target;
    if (!this.#active || !(t instanceof HTMLElement) || !t.matches('.coach input')) return;
    // The keyboard comes up for the Ask box: the sheet comes up with it, over the board.
    if (!this.#sheet.full) {
      this.#raisedByKeyboard = true;
      this.#sheet.pullUp();
    }
  }

  #focusOut(): void {
    if (!this.#raisedByKeyboard) return;
    clearTimeout(this.#blurTimer);
    // A moment later, as today's board does, so the tap that took the focus away lands where it was aimed.
    this.#blurTimer = setTimeout(() => {
      const focused = document.activeElement;
      if (!this.#raisedByKeyboard || (focused instanceof HTMLElement && focused.matches('.coach input'))) return;
      this.#raisedByKeyboard = false;
      this.#sheet.full = false;
    }, 400);
  }

  /** The handle's tap: the user takes over from the keyboard. */
  toggle(): void {
    this.#raisedByKeyboard = false;
    this.#sheet.toggle();
  }
}

export const v3: SheetDriver = {
  // Untracked: an attachment that read `sheet.full` would be torn down and made again on every change.
  panel: (sheet, node) => untrack(() => {
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
    // The band of the board above the sheet: a tap brings the board back, a drag down pulls the sheet down.
    const click = (e: MouseEvent) => {
      if (current?.justDragged(e)) return;
      sheet.full = false;
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
