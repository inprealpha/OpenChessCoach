// PROTOTYPE (#80), version 1: the phone's panel sheet moved by transforms alone, as a native sheet
// is. At rest nothing in it scrolls and a vertical drag anywhere on it moves it with the finger, the
// board shrinking as it rises; let go, it slides where it was heading (swipe-v1.ts). Pulled up, its
// content scrolls, and a drag down that starts with the content at its top lowers it again. Every
// move the app makes itself (the handle, the strip, a Why Question, Continue, the keyboard) slides
// the same way, unless the Player asked for less motion.
//
// How it stays smooth: while the sheet moves, the screen is laid out once in a "moving" layout and
// nothing in it is laid out again until it stops. The board column keeps its size at rest, so the
// board is drawn from its full-size picture and only ever shrinks; the panel is laid out as tall as
// it is pulled up, with its top where it ends up and a negative margin under the board making
// room. Each frame then only writes transforms (and the Coach's clip): the panel slides, the
// Coach's Ask box stays docked at the screen's foot, and the board, its Winning Chances bar and the
// line under it scale and move between where they are drawn at rest and pulled up. When it stops,
// the real layout comes back in one step, drawn exactly where the last frame left everything.
import type { Sheet } from '../sheet.svelte.ts';
import { EASE, SETTLE_MS, SLOP, ease, follow, heading, hold, owner, settleMs, type Owner } from './swipe-v1.ts';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the sheet's parts are laid out in one of its two states, in viewport pixels, untransformed. */
interface Layout {
  /** The panel's top edge. */
  top: number;
  /** The board column's height. */
  col: number;
  /** The Coach's height, docked at the foot. */
  coach: number;
  board: Box | null;
  under: Box | null;
  bar: Box | null;
}

/**
 * What a move is between: the sheet pulled up (`full`), or at rest with the board a strip above
 * the keyboard while the Player types (`typing`), and the layouts at both ends.
 */
interface Geometry {
  kind: 'full' | 'typing';
  rest: Layout;
  up: Layout;
  /** The board column's size at rest, which it keeps while the sheet moves. */
  boardMax: string;
  padTop: string;
  padBottom: string;
}

interface Parts {
  panel: HTMLElement;
  col: HTMLElement;
  /** Where the screen has one docked at the panel's foot (a Puzzle has none until it is solved). */
  coach: HTMLElement | null;
  /** The Coach's rows at its foot (the Ask box): docked at the screen's foot. */
  rows: HTMLElement[];
  board: HTMLElement | null;
  under: HTMLElement | null;
  bar: HTMLElement | null;
}

interface Gesture {
  x: number;
  y: number;
  /** Where the sheet's top was drawn when the finger touched it. */
  from: number;
  /** Laid out pulled up when touched. */
  up: boolean;
  /** The content under the finger was scrolled to its top. */
  atTop: boolean;
  /** The keyboard was up: a drag down closes it. */
  keyboard: boolean;
  /** Caught while sliding: where it was sliding to (up or not), resumed if the touch is a tap. */
  caught: boolean | null;
  mode: Owner;
  samples: { t: number; y: number }[];
  /** Both ends, measured when the finger touched, so the drag's first frame only lays out once. */
  geo: Geometry | null;
}

/** A touch here is typing, never a drag. */
const TEXT = 'input, textarea, select, [contenteditable], .coach form';
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const box = (el: Element | null): Box | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/** The sheet's motion on each board screen, so the handle can drag it with a mouse too. */
export const motions = new WeakMap<HTMLElement, Motion>();

export class Motion {
  readonly #sheet: Sheet;
  readonly #frame: HTMLElement;
  /** Set while the sheet is in the moving layout. */
  #geo: Geometry | null = null;
  #parts: Parts | null = null;
  /** The sheet's top as drawn now, while it moves. */
  #y = 0;
  /** The Coach's height in the moving layout: the Ask box's row can come and go while it moves. */
  #coachH = 0;
  /** The Coach's height pulled up, when the move started there; otherwise its live height. */
  #upCoach: number | null = null;
  #run: { from: number; to: number; ms: number; up: boolean; elapsed: number; anims: Animation[] } | null = null;
  #gesture: Gesture | null = null;
  /** The sheet's own `full` change, made by a drag: the listener leaves it to the drag. */
  #quiet = false;
  /** Where a drag sent the sheet, until the app is told. */
  #pending: boolean | null = null;
  /** When the last drag ended: the click a browser may send after it is not a tap. */
  #dragEnd = -Infinity;
  #queued = false;
  /** The screen has been drawn once: changes before that (a screen opening) don't slide. */
  ready = false;
  readonly #watch: ResizeObserver;

  constructor(sheet: Sheet, frame: HTMLElement) {
    this.#sheet = sheet;
    this.#frame = frame;
    this.#watch = new ResizeObserver((entries) => {
      const h = entries.at(-1)?.borderBoxSize?.[0]?.blockSize ?? this.#parts?.coach?.offsetHeight ?? 0;
      if (!this.#geo || Math.abs(h - this.#coachH) < 0.5) return;
      this.#coachH = h;
      this.#redraw();
    });
  }

  /** A change of `full` (from the listener) or of the keyboard: slides there, where it can. */
  go(kind: 'full' | 'typing', up: boolean): void {
    if (this.#quiet || this.#gesture?.mode === 'sheet') return;
    this.#pending = null;
    const run = this.#run;
    if (!this.ready || !this.#sheet.on || calm()) return this.#stop();
    if (this.#geo && this.#geo.kind !== kind) this.#stop();
    let from: number;
    if (this.#geo) {
      // Retargeted while sliding: from where it is drawn now.
      from = run ? this.current() : this.#y;
      this.#cancel();
    } else {
      if (!this.#enter(kind)) return;
      const geo = this.#geo!;
      from = up ? geo.rest.top : geo.up.top;
      this.#upCoach = up ? null : geo.up.coach;
    }
    this.#slide(from, up, SETTLE_MS);
  }

  /** The sheet's top as drawn now. */
  current(): number {
    const run = this.#run;
    if (!run) return this.#y;
    // Not started yet (it starts on the next frame): still where it starts.
    const time = Number(run.anims[0]?.currentTime ?? run.elapsed);
    return lerp(run.from, run.to, ease(time / run.ms));
  }

  /** Whether a click now ends a drag rather than being a tap. */
  swallows(): boolean {
    return performance.now() - this.#dragEnd < 150;
  }

  // ---- Gestures ----

  /** A finger (or the mouse, on the handle) touches the sheet. */
  press(x: number, y: number, target: Element): void {
    this.#gesture = null;
    if (!this.#sheet.on || !this.#frame.classList.contains('board-screen') || target.closest(TEXT)) return;
    const active = document.activeElement;
    const keyboard = Boolean(active && active !== document.body && active.matches(TEXT) && this.#frame.contains(active));
    const up = this.#frame.classList.contains('sheet-full') || Boolean(this.#frame.querySelector('.coach input.typing'));
    let caught: boolean | null = null;
    if (this.#run) {
      // A touch catches the sheet where it is, as a finger catches a sliding sheet of paper.
      caught = this.#run.up;
      this.#y = this.current();
      this.#cancel();
      this.#draw(this.#y);
    }
    const scroller = this.#scrollerAt(target);
    const atTop = !scroller || scroller.scrollTop <= 0;
    // A drag that may become the sheet's is measured now, while the finger hasn't moved.
    const geo = !this.#geo && !keyboard && (!up || atTop) ? this.#measureNow('full') : null;
    this.#gesture = { x, y, from: this.#y, up, atTop, keyboard, caught, mode: 'wait', samples: [], geo };
  }

  /** The finger moves: `e` is the touch or pointer event, whose scrolling the sheet may hold. */
  move(x: number, y: number, e: Event): void {
    const g = this.#gesture;
    if (!g || g.mode === 'none' || g.mode === 'scroll') return;
    const dx = x - g.x;
    const dy = y - g.y;
    if (g.mode === 'wait') {
      if (g.keyboard) {
        // With the keyboard up, the first drag down closes it; nothing else moves.
        if (dy > SLOP && dy > Math.abs(dx)) {
          if (e.cancelable) e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          g.mode = 'none';
        } else if (Math.abs(dx) > SLOP || -dy > SLOP) g.mode = 'none';
        return;
      }
      // Caught mid-slide, it behaves as at rest: any vertical drag carries it on.
      const up = g.caught === null && g.up;
      if (hold(up, g.atTop, dx, dy) && e.cancelable) e.preventDefault();
      const o = owner(up, g.atTop, dx, dy);
      if (o === 'wait') return;
      g.mode = o;
      if (o !== 'sheet') return this.#resume(g);
      if (!this.#geo) {
        if (!this.#enter('full', g.geo)) {
          g.mode = 'none';
          return;
        }
        const geo = this.#geo!;
        g.from = g.up ? geo.up.top : geo.rest.top;
        this.#upCoach = g.up ? geo.up.coach : null;
        this.#y = g.from;
        this.#draw(g.from);
      }
    }
    if (e.cancelable) e.preventDefault();
    const geo = this.#geo!;
    // Exactly the finger's travel since it touched: no catching up after the slop.
    this.#y = follow(g.from, dy, geo.up.top, geo.rest.top);
    g.samples.push({ t: e.timeStamp, y });
    if (g.samples.length > 6) g.samples.shift();
    this.#queue();
  }

  /** The finger lifts, or a second finger lands: the sheet goes where it was heading. */
  release(t: number, stillSpeed = false): void {
    const g = this.#gesture;
    this.#gesture = null;
    if (!g) return;
    if (g.mode !== 'sheet') return this.#resume(g);
    this.#dragEnd = performance.now();
    const geo = this.#geo!;
    const speed = stillSpeed ? 0 : this.#speed(g.samples, t);
    const wasUp = g.caught ?? g.up;
    const span = geo.rest.top - geo.up.top;
    const toward = wasUp ? this.#y - geo.up.top : geo.rest.top - this.#y;
    const next = heading(wasUp, toward, wasUp ? speed : -speed, span);
    this.#pending = next;
    if (calm()) return this.#stop();
    const to = next ? geo.up.top : geo.rest.top;
    this.#slide(this.#y, next, settleMs(to - this.#y, speed));
    // The screens redraw for the new state once the slide is under way, on the compositor, so the
    // work doesn't hold up its first frame.
    requestAnimationFrame(() => setTimeout(() => this.#commitFull(), 0));
  }

  /** The drag's outcome, told to the app: the sheet is up, or down. */
  #commitFull(): void {
    const next = this.#pending;
    if (next === null) return;
    this.#pending = null;
    this.#quiet = true;
    this.#sheet.full = next;
    this.#quiet = false;
  }

  /** Stops whatever the sheet is doing and lays it out where it belongs (a turn of the phone). */
  stop(): void {
    this.#gesture = null;
    this.#stop();
  }

  detach(): void {
    this.stop();
    this.#watch.disconnect();
  }

  // ---- The moving layout ----

  /** Measures both ends and lays the screen out for moving. False where there is nothing to move. */
  #enter(kind: 'full' | 'typing', measured: Geometry | null = null): boolean {
    const frame = this.#frame;
    const { panel, col, coach } = this.#find();
    if (!panel || !col) return false;
    const geo = measured ?? this.#measure(kind, panel, col, coach);
    if (geo.rest.top - geo.up.top < 1) return false;
    this.#geo = geo;
    this.#parts = {
      panel,
      col,
      coach,
      rows: [...(coach?.querySelectorAll<HTMLElement>(':scope > :is(.log-actions, .actions, .thumb-row)') ?? [])],
      board: col.querySelector('.board'),
      under: col.querySelector('.under'),
      bar: col.querySelector('.wc-bar'),
    };
    frame.classList.add('v1-moving');
    if (kind === 'full') frame.classList.add('v1-lifted');
    col.style.setProperty('--board-max', geo.boardMax);
    col.style.paddingTop = geo.padTop;
    col.style.paddingBottom = geo.padBottom;
    col.style.marginBottom = `${geo.up.col - geo.rest.col}px`;
    this.#coachH = geo.up.coach;
    if (coach) this.#watch.observe(coach);
    return true;
  }

  #find(): { panel: HTMLElement | null; col: HTMLElement | null; coach: HTMLElement | null } {
    const frame = this.#frame;
    const panel = frame.classList.contains('board-screen') ? frame.querySelector<HTMLElement>('.side.panel') : null;
    return { panel, col: frame.querySelector<HTMLElement>('.board-col'), coach: panel?.querySelector<HTMLElement>(':scope > .coach') ?? null };
  }

  #measureNow(kind: 'full' | 'typing'): Geometry | null {
    const { panel, col, coach } = this.#find();
    return panel && col ? this.#measure(kind, panel, col, coach) : null;
  }

  /**
   * Both ends, laid out for a moment each by the class that makes the difference: the sheet's
   * `sheet-full`, or the Ask box's `typing` (app.css). The Ask box's "Put the answer away" row only
   * shows pulled up, so it is left out at rest.
   */
  #measure(kind: 'full' | 'typing', panel: HTMLElement, col: HTMLElement, coach: HTMLElement | null): Geometry {
    const frame = this.#frame;
    const input = coach?.querySelector<HTMLElement>('input') ?? null;
    const hadFull = frame.classList.contains('sheet-full');
    const hadTyping = input?.classList.contains('typing') ?? false;
    const set = (on: boolean) => (kind === 'full' ? frame.classList.toggle('sheet-full', on) : input?.classList.toggle('typing', on));
    const read = (): Layout => ({
      top: panel.getBoundingClientRect().top,
      col: col.getBoundingClientRect().height,
      coach: coach?.getBoundingClientRect().height ?? 0,
      board: box(col.querySelector('.board')),
      under: box(col.querySelector('.under')),
      bar: box(col.querySelector('.wc-bar')),
    });
    const row = coach?.querySelector<HTMLElement>('.log-actions') ?? null;
    let rest: Layout | undefined;
    let up: Layout | undefined;
    let boardMax = '';
    let padTop = '';
    let padBottom = '';
    const readRest = () => {
      set(false);
      if (row) row.style.display = 'none';
      const style = getComputedStyle(col);
      rest = read();
      boardMax = style.getPropertyValue('--board-max');
      padTop = style.paddingTop;
      padBottom = style.paddingBottom;
      if (row) row.style.display = '';
    };
    const readUp = () => {
      set(true);
      up = read();
    };
    // No transitions while measuring: with less motion asked for, app.css gives every property a
    // near-zero one, which would leave the other end's layout a frame behind the class.
    frame.classList.add('v1-measuring');
    // The end it is laid out at first, which costs no layout; then the other.
    if (kind === 'full' ? hadFull : hadTyping) {
      readUp();
      readRest();
    } else {
      readRest();
      readUp();
    }
    frame.classList.toggle('sheet-full', hadFull);
    input?.classList.toggle('typing', hadTyping);
    // With those near-zero transitions, settle the restored layout before they come back.
    if (calm()) void panel.offsetTop;
    frame.classList.remove('v1-measuring');
    return { kind, rest: rest!, up: up!, boardMax, padTop, padBottom };
  }

  /** What every moving part is drawn as, for the sheet's top at `y`: one list per part. */
  #styles(y: number): { el: HTMLElement; style: Record<string, string> }[] {
    const geo = this.#geo!;
    const parts = this.#parts!;
    const { rest, up } = geo;
    const span = rest.top - up.top;
    // How far up it is drawn, 0 at rest and 1 pulled up; past the ends only the panel moves on.
    const p = Math.min(1, Math.max(0, (rest.top - y) / span));
    // The Coach's top edge rises with the panel from its height at rest to its height pulled up.
    // It is laid out as pulled up and slid down by what it shows less (`cut`), its foot past the
    // screen's, while its rows (the Ask box) slide back up to stay docked over its words.
    const shown = lerp(rest.coach, this.#upCoach ?? this.#coachH, p);
    const cut = this.#coachH - shown;
    const out: { el: HTMLElement; style: Record<string, string> }[] = [
      { el: parts.panel, style: { transform: `translate3d(0, ${y - up.top}px, 0)` } },
    ];
    if (parts.coach) {
      out.push({ el: parts.coach, style: { transform: `translate3d(0, ${up.top - y + cut}px, 0)` } });
      for (const el of parts.rows) out.push({ el, style: { transform: `translate3d(0, ${-cut}px, 0)` } });
    }
    const piece = (el: HTMLElement | null, a: Box | null, b: Box | null, how: 'scale' | 'wide' | 'move') => {
      if (!el || !a || !b) return;
      const left = lerp(a.left, b.left, p);
      const top = lerp(a.top, b.top, p);
      const k = lerp(a.width, b.width, p) / a.width;
      // The line under the board keeps its type size: it moves by its centre.
      const dx = how === 'move' ? lerp(a.left + a.width / 2, b.left + b.width / 2, p) - (a.left + a.width / 2) : left - a.left;
      const sx = how === 'move' ? 1 : k;
      const sy = how === 'scale' ? k : 1;
      out.push({ el, style: { transform: `translate3d(${dx}px, ${top - a.top}px, 0) scale(${sx}, ${sy})` } });
    };
    piece(parts.board, rest.board, up.board, 'scale');
    piece(parts.bar, rest.bar, up.bar, 'wide');
    piece(parts.under, rest.under, up.under, 'move');
    return out;
  }

  /** Draws the sheet's top at `y` now, in inline styles (while a finger holds it). */
  #draw(y: number): void {
    for (const { el, style } of this.#styles(y)) Object.assign(el.style, style);
  }

  /** At most one draw per frame, in the frame's own callback, whatever the touch events' rate. */
  #queue(): void {
    if (this.#queued) return;
    this.#queued = true;
    requestAnimationFrame(() => {
      this.#queued = false;
      if (this.#geo && !this.#run) this.#draw(this.#y);
    });
  }

  /** The Coach changed height while moving: the same place, drawn again. */
  #redraw(): void {
    const run = this.#run;
    if (!run) return this.#draw(this.#y);
    const time = Number(run.anims[0]?.currentTime ?? run.elapsed);
    this.#cancel();
    this.#slide(run.from, run.up, run.ms, time);
  }

  /**
   * Slides the sheet's top from `from` to the end `up` names in `ms`, eased, on the compositor:
   * one animation per part, its keyframes sampled from the same drawing as a drag's frames.
   */
  #slide(from: number, up: boolean, ms: number, elapsed = 0): void {
    const geo = this.#geo!;
    const to = up ? geo.up.top : geo.rest.top;
    // Where it is drawn now: its start, or, picked up part-way (the Coach changed height), there.
    this.#draw(lerp(from, to, ease(elapsed / ms)));
    const steps = 8;
    const frames = Array.from({ length: steps + 1 }, (_, i) => this.#styles(lerp(from, to, i / steps)));
    const run = { from, to, ms, up, elapsed, anims: [] as Animation[] };
    this.#run = run;
    this.#y = from;
    // Started on the next frame, from the frame's own time: a browser that has drawn nothing for a
    // while (WebKit) would otherwise date the start back to its last frame and skip the slide's
    // first part. Until then the inline style holds the sheet where it starts.
    requestAnimationFrame(() => {
      if (this.#run !== run) return;
      run.anims = frames[0]!.map(({ el }, j) => {
        // Only what changes is animated: a value that stays put stays in the inline style.
        const keys = Object.keys(frames[0]![j]!.style).filter((k) => frames.some((f) => f[j]!.style[k] !== frames[0]![j]!.style[k]));
        const keyframes = frames.map((f, i) => ({ offset: i / steps, ...Object.fromEntries(keys.map((k) => [k, f[j]!.style[k]!])) }));
        const anim = el.animate(keyframes, { duration: ms, easing: EASE, fill: 'forwards' });
        anim.currentTime = elapsed;
        return anim;
      });
      run.anims[0]!.onfinish = () => {
        if (this.#run === run) this.#stop();
      };
    });
  }

  /** Lets a caught slide carry on to where it was going: the touch was a tap, a scroll or sideways. */
  #resume(g: Gesture): void {
    if (g.caught === null || !this.#geo || this.#run) return;
    this.#slide(this.#y, g.caught, SETTLE_MS);
  }

  #cancel(): void {
    const run = this.#run;
    this.#run = null;
    for (const a of run?.anims ?? []) a.cancel();
  }

  /** Back to the real layout, in one step: everything was drawn where that layout puts it. */
  #stop(): void {
    this.#cancel();
    this.#commitFull();
    const parts = this.#parts;
    this.#geo = null;
    this.#parts = null;
    this.#upCoach = null;
    this.#watch.disconnect();
    this.#frame.classList.remove('v1-moving', 'v1-lifted');
    if (!parts) return;
    for (const el of [parts.panel, parts.coach, ...parts.rows, parts.board, parts.under, parts.bar]) if (el) el.style.transform = '';
    parts.col.style.removeProperty('--board-max');
    parts.col.style.paddingTop = '';
    parts.col.style.paddingBottom = '';
    parts.col.style.marginBottom = '';
  }

  /** The finger's speed in px/ms (positive: down), over its last 100 ms. */
  #speed(samples: { t: number; y: number }[], now: number): number {
    const last = samples.at(-1);
    if (!last || now - last.t > 100) return 0;
    const first = samples.find((s) => last.t - s.t <= 100) ?? last;
    return last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
  }

  /** The box that scrolls under the finger, in the panel: its content, or the Coach's log. */
  #scrollerAt(target: Element): HTMLElement | null {
    const panel = target.closest('.side.panel');
    for (let el: Element | null = target; el && el !== panel; el = el.parentElement) {
      if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  }
}
