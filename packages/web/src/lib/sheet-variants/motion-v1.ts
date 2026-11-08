// PROTOTYPE (#80), version 1: the phone's panel sheet moved by transforms alone, as a native sheet
// is. At rest nothing in it scrolls and a vertical drag anywhere on it moves it with the finger from
// the first pixel the browser reports, the board shrinking as it rises; let go, it slides where it
// was heading (swipe-v1.ts). Pulled up, its content scrolls, and a drag down that starts with the
// content at its top lowers it again. Every move the app makes itself (the handle, the strip, a Why
// Question, Continue, the keyboard) slides the same way, unless the Player asked for less motion.
//
// How it stays smooth: both ends (at rest and pulled up) are measured ahead of time, while nothing
// moves, and measured again when the screen, the window or the Coach changes size. While the sheet
// moves, the screen is laid out once in a "moving" layout and nothing in it is laid out again until
// it stops. The board column keeps its size at rest, so the board is drawn from its full-size
// picture and only ever shrinks; the panel is laid out as tall as it is pulled up, with its top where
// it ends up and a negative margin under the board making room; the Coach's log is laid out as tall
// as it is pulled up. Each frame then only writes transforms: the panel slides, the Coach's top edge
// rises and falls with it while its Ask box stays docked, what the Coach and the content show slide
// to where they will be scrolled, and the board, its bar (whose numbers keep their size), its
// coordinates and the line under it go from where they are drawn at rest to where they are drawn
// pulled up. When it stops, the real layout comes back in one step, drawn exactly where the last
// frame left everything. What the app adds or removes as the sheet goes up or down ("Put the answer
// away", "Read all") fades rather than appearing or vanishing in one frame.
import { flushSync } from 'svelte';
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
  /** The Coach's height, docked at the foot, and its log's. */
  coach: number;
  log: number;
  /** The content's box. */
  body: number;
  board: Box | null;
  under: Box | null;
  bar: Box | null;
}

/** The two ends of a move, the sheet at rest and pulled up, and the board column's size at rest. */
interface Stops {
  rest: Layout;
  up: Layout;
  boardMax: string;
  padTop: string;
  padBottom: string;
}

/** A box whose content scrolls (the content, the Coach's log): where it is scrolled at either end. */
interface Scroll {
  el: HTMLElement;
  kids: HTMLElement[];
  /** Where it is scrolled while moving, and where it will be at rest and pulled up. */
  now: number;
  rest: number;
  up: number;
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
  /** The line under the board as it wraps pulled up, where that differs: the two cross-fade. */
  underThere: HTMLElement | null;
  bar: HTMLElement | null;
  /** The bar's two numbers, which keep their size as the bar narrows. */
  numbers: HTMLElement[];
  /** The board's coordinates, which keep their size as the board shrinks. */
  coords: HTMLElement[];
  scrolls: Scroll[];
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
  /** Moving with the finger before the drag is told from a tap: put back if it is a tap. */
  tentative: boolean;
  samples: { t: number; y: number }[];
}

interface Run {
  from: number;
  to: number;
  ms: number;
  up: boolean;
  elapsed: number;
  anims: Animation[];
}

/** A touch here is typing, never a drag. */
const TEXT = 'input, textarea, select, [contenteditable], .coach form';
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const box = (el: Element | null): Box | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};
/** How long what the app adds or removes takes to fade in or out. */
const FADE_MS = 180;

/** The sheet's motion on each board screen, so the handle can drag it with a mouse too. */
export const motions = new WeakMap<HTMLElement, Motion>();

export class Motion {
  readonly #sheet: Sheet;
  readonly #frame: HTMLElement;
  /** Both ends, measured while nothing moves; null or dirty when the screen has changed since. */
  #stops: Stops | null = null;
  #dirty = true;
  #refreshing: ReturnType<typeof setTimeout> | undefined;
  /** Watches the screen's parts for a change of size, which calls for measuring the ends again. */
  readonly #sizes: ResizeObserver;
  /** Set while the sheet is in the moving layout: the ends it moves between. */
  #geo: Stops | null = null;
  #kind: 'full' | 'typing' = 'full';
  #parts: Parts | null = null;
  /** The Coach laid out as pulled up (a drag past the slop, or a slide to or from pulled up). */
  #lifted = false;
  /** How far the Coach's log was scrolled, and its content's height, when the move began. */
  #logAt: { now: number; content: number; box: number } | null = null;
  /** The sheet's top as drawn now, while it moves. */
  #y = 0;
  /**
   * The Coach's height as its content lays it out (`natural`: the Ask box's row can come and go while
   * it moves), and its box's (`box`): lifted, the box is laid out as tall as it can get, over the
   * content above it, so its top edge can rise without anything being laid out again.
   */
  #natural = 0;
  #box = 0;
  /** The Coach's padding under its Ask box. */
  #pad = 0;
  /**
   * The Coach's height pulled up, as known when the move started, and what it gained or lost since
   * (a row the app added or removed): each from how far up the sheet was then, so the Coach's top
   * edge goes on from where it is drawn rather than jumping to the new height.
   */
  #upCoach = 0;
  #ramps: { from: number; by: number }[] = [];
  /** The Coach's height to aim for pulled up, waiting for the sheet to head up again. */
  #later = 0;
  #run: Run | null = null;
  #gesture: Gesture | null = null;
  /** The sheet's own `full` change: the listener leaves it to the motion that made it. */
  #quiet = false;
  /** Where the sheet is going, until the app is told. */
  #pending: boolean | null = null;
  /** The end the sheet is at or on its way to, while it moves. */
  #end = false;
  /** How much taller "Put the answer away" makes the Coach, as last measured (0: not yet). */
  #rowGrowth = 0;
  /** The row's room is already reckoned with in this move. */
  #rowAimed = false;
  /** When the last drag ended: the click a browser may send after it is not a tap. */
  #dragEnd = -Infinity;
  #queued = false;
  /** The screen has been drawn once: changes before that (a screen opening) don't slide. */
  ready = false;
  readonly #coachWatch: ResizeObserver;
  /** Watches the Coach's rows: a row the app adds or removes while the sheet moves. */
  readonly #rowWatch: MutationObserver;
  /** A touch that ended as a tap: the moving layout it was given goes, unless a slide takes it on. */
  #idle: ReturnType<typeof setTimeout> | undefined;

  constructor(sheet: Sheet, frame: HTMLElement) {
    this.#sheet = sheet;
    this.#frame = frame;
    this.#coachWatch = new ResizeObserver(() => this.#resync());
    this.#rowWatch = new MutationObserver(() => this.#resync());
    this.#sizes = new ResizeObserver((entries) => {
      // Only a change of size since it was last seen: not the report every box gets when watched.
      let changed = false;
      for (const e of entries) {
        const size = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
        const seen = this.#seen.get(e.target);
        this.#seen.set(e.target, size);
        if (seen !== undefined && seen !== size) changed = true;
      }
      if (changed && !this.#geo) this.changed();
    });
  }

  /** The sizes the watched boxes were last seen at. */
  readonly #seen = new WeakMap<Element, string>();

  // ---- The two ends, measured ahead of time ----

  /** The screen changed: the ends are measured again once it has settled. */
  changed(): void {
    this.#dirty = true;
    clearTimeout(this.#refreshing);
    this.#refreshing = setTimeout(() => this.refresh(), 250);
  }

  /** Measures both ends now, while nothing moves; later if something does. */
  refresh(now = false): void {
    clearTimeout(this.#refreshing);
    if (this.#geo || (this.#gesture && !now)) return this.changed();
    const { panel, col, coach } = this.#find();
    if (!panel || !col || !this.#sheet.on) return;
    for (const el of [panel, col, coach, panel.querySelector(':scope > .panel-body'), coach?.querySelector('.log')]) if (el) this.#sizes.observe(el);
    this.#stops = this.#measure(panel, col, coach);
    this.#dirty = false;
  }

  /** The ends, measured ahead of time; or now, if the screen changed and the measure is still to come. */
  #ends(): Stops | null {
    if (this.#stops && !this.#dirty) return this.#stops;
    this.refresh(true);
    return this.#dirty ? null : this.#stops;
  }

  // ---- Moves the app makes, and the handle's ----

  /** A change of `full` the app made (the listener), or of the keyboard: slides there, where it can. */
  go(kind: 'full' | 'typing', up: boolean): void {
    if (this.#quiet || this.#gesture?.mode === 'sheet') return;
    this.#pending = null;
    if (!this.ready || !this.#sheet.on || calm()) return this.#stop();
    // What the app takes away as the sheet comes up or down fades out where it was drawn.
    if (kind === 'full' && !this.#geo) this.#fadeOut(up ? '.coach .read-all' : '.coach .log-actions');
    // The app redraws for the change right after this (a microtask of its own): the Coach's new
    // height is taken in, before anything is drawn.
    if (this.#slideTo(kind, up)) queueMicrotask(() => this.#resync());
  }

  /** The Coach changed under the moving sheet (a row came or went): drawn again for it now. */
  #resync(): void {
    const parts = this.#parts;
    const coach = parts?.coach;
    if (!this.#geo || !coach) return;
    parts.rows = [...coach.querySelectorAll<HTMLElement>(':scope > :is(.log-actions, .actions, .thumb-row)')];
    const last = parts.rows.at(-1);
    const natural = last ? last.offsetTop + last.offsetHeight + this.#pad : coach.offsetHeight;
    if (Math.abs(natural - this.#natural) < 0.5) return;
    const by = natural - this.#natural;
    this.#natural = natural;
    this.#box = this.#lifted ? Math.max(this.#box, natural) : natural;
    // Laid out pulled up, the Coach is as tall pulled up as it is now (a row came or went).
    if (this.#lifted && this.#kind === 'full') this.#aim(by);
    this.#redraw();
  }

  /** The Coach will be `by` taller pulled up: from here, if heading up; once it heads up, if not. */
  #aim(by: number): void {
    if (this.#end) this.#ramps.push({ from: this.#p(this.current()), by });
    else this.#later += by;
  }

  /** How far up the sheet is drawn at `y`: 0 at rest, 1 pulled up. */
  #p(y: number): number {
    const geo = this.#geo!;
    return clamp((geo.rest.top - y) / (geo.rest.top - geo.up.top), 0, 1);
  }

  /** The handle: up or down, sliding first and telling the app once the slide is under way. */
  toggle(): void {
    this.#move(!(this.#pending ?? this.#run?.up ?? this.#sheet.full));
  }

  /** The board strip: back down. */
  lower(): void {
    this.#move(false);
  }

  /** A wheel turned down at rest: up. */
  raise(): void {
    if (!this.#sheet.full && !this.#pending) this.#move(true);
  }

  #move(up: boolean): void {
    if (!this.ready || !this.#sheet.on || calm() || this.#gesture?.mode === 'sheet') {
      this.#stop();
      this.#sheet.full = up;
      return;
    }
    if (!this.#slideTo('full', up)) {
      this.#sheet.full = up;
      return;
    }
    this.#tell(up);
  }

  /** Slides from where the sheet is drawn to `up`; false where it can't (nothing to move). */
  #slideTo(kind: 'full' | 'typing', up: boolean): boolean {
    if (this.#geo && this.#kind !== kind) this.#stop();
    let from: number;
    if (this.#geo) {
      // Retargeted while sliding or held: from where it is drawn now.
      from = this.current();
      this.#cancel();
      if (kind === 'full') this.#lift();
    } else {
      if (!this.#enter(kind, true)) return false;
      const geo = this.#geo!;
      from = up ? geo.rest.top : geo.up.top;
    }
    this.#slide(from, up, SETTLE_MS);
    return true;
  }

  /**
   * Where the sheet is going, told to the app once it gets there: the screens redraw for it while
   * nothing moves, not during the slide. What that redraw adds or takes away in the Coach is
   * reckoned with now: "Put the answer away" fades out as the sheet comes down, and pulled up it
   * will take its room, which the Coach's top edge rises to meet.
   */
  #tell(up: boolean): void {
    this.#pending = up;
    const coach = this.#parts?.coach;
    if (!coach) return;
    const row = coach.querySelector(':scope > .log-actions');
    this.#frame.classList.toggle('v1-falling', !up && Boolean(row));
    // Pulled up, the row shows after the Player's own question, once the Coach has answered it.
    const answered = Boolean(coach.querySelector('.log > .entry.from-player')) && !coach.querySelector('[aria-busy="true"]');
    if (up && answered && !row && this.#lifted && !this.#rowAimed) {
      this.#rowAimed = true;
      this.#aim(this.#rowGrowth || (coach.querySelector<HTMLElement>(':scope > .thumb-row')?.offsetHeight ?? 0));
      this.#redraw();
    }
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

  /** A finger (or the mouse, on the handle) touches the sheet. No layout here: the ends are known. */
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
    const g: Gesture = { x, y, from: this.#y, up, atTop, keyboard, caught, mode: 'wait', tentative: false, samples: [] };
    this.#gesture = g;
    clearTimeout(this.#idle);
    // Laid out for moving now, while the finger rests, wherever nothing under it could scroll (the
    // sheet at rest, the handle): the layout is done before the finger moves, and a tap changes
    // nothing that is drawn. Where it could scroll, that waits for the drag to be the sheet's.
    if (!keyboard && (!up || !scroller)) {
      // On the next frame, with that frame's own style and layout, not forcing them in the event.
      requestAnimationFrame(() => {
        if (this.#gesture === g && !this.#geo) this.#hold(g);
      });
    }
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
      const mine = hold(up, g.atTop, dx, dy);
      if (mine && e.cancelable) e.preventDefault();
      const o = owner(up, g.atTop, dx, dy);
      if (o === 'wait') {
        // Inside the slop, it already moves with the finger, from the first pixel reported.
        if (mine && dy !== 0 && this.#hold(g)) {
          g.tentative = true;
          this.#follow(g, dy, e);
        }
        return;
      }
      g.mode = o;
      if (o !== 'sheet') return this.#putBack(g);
      if (!this.#hold(g)) {
        g.mode = 'none';
        return;
      }
      this.#lift();
    }
    if (e.cancelable) e.preventDefault();
    this.#follow(g, dy, e);
  }

  /** Lays the sheet out for moving under the finger, if it isn't already. */
  #hold(g: Gesture): boolean {
    if (this.#geo) return true;
    if (!this.#enter('full', false)) return false;
    const geo = this.#geo!;
    g.from = g.up ? geo.up.top : geo.rest.top;
    this.#y = g.from;
    this.#draw(g.from);
    return true;
  }

  /** The sheet's top under the finger: exactly its travel since it touched, between the two ends. */
  #follow(g: Gesture, dy: number, e: Event): void {
    const geo = this.#geo!;
    this.#y = follow(g.from, dy, geo.up.top, geo.rest.top);
    g.samples.push({ t: e.timeStamp, y: g.y + dy });
    if (g.samples.length > 6) g.samples.shift();
    this.#queue();
  }

  /** The touch was not the sheet's after all (a tap, a scroll, sideways): back where it was. */
  #putBack(g: Gesture): void {
    if (g.caught !== null && this.#geo) return this.#slide(this.#y, g.caught, SETTLE_MS);
    if (!this.#geo || this.#run) return;
    if (Math.abs(this.#y - g.from) >= 0.5) return this.#slide(this.#y, g.up, 120);
    // A tap: the click it makes (on the handle, say) may start a slide from this layout.
    this.#idle = setTimeout(() => {
      if (!this.#run && !this.#gesture) this.#stop();
    }, 80);
  }

  /** The finger lifts, or a second finger lands: the sheet goes where it was heading. */
  release(t: number, stillSpeed = false): void {
    const g = this.#gesture;
    this.#gesture = null;
    if (!g) return;
    if (g.mode !== 'sheet') return this.#putBack(g);
    this.#dragEnd = performance.now();
    const geo = this.#geo!;
    const speed = stillSpeed ? 0 : this.#speed(g.samples, t);
    const wasUp = g.caught ?? g.up;
    const span = geo.rest.top - geo.up.top;
    const toward = wasUp ? this.#y - geo.up.top : geo.rest.top - this.#y;
    const next = heading(wasUp, toward, wasUp ? speed : -speed, span);
    if (calm()) {
      this.#pending = next;
      return this.#stop();
    }
    const to = next ? geo.up.top : geo.rest.top;
    this.#slide(this.#y, next, settleMs(to - this.#y, speed));
    this.#tell(next);
  }

  /** Where the sheet went, told to the app: the screens redraw for it. */
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
    this.changed();
  }

  detach(): void {
    this.stop();
    clearTimeout(this.#refreshing);
    this.#coachWatch.disconnect();
    this.#sizes.disconnect();
  }

  // ---- The moving layout ----

  #find(): { panel: HTMLElement | null; col: HTMLElement | null; coach: HTMLElement | null } {
    const frame = this.#frame;
    const panel = frame.classList.contains('board-screen') ? frame.querySelector<HTMLElement>('.side.panel') : null;
    return { panel, col: frame.querySelector<HTMLElement>('.board-col'), coach: panel?.querySelector<HTMLElement>(':scope > .coach') ?? null };
  }

  /**
   * Lays the screen out for moving, between the ends measured ahead of time. `lifted`: the Coach is
   * laid out as pulled up too (otherwise that waits for the drag to be told from a tap, so a tap
   * changes nothing in it). False where there is nothing to move.
   */
  #enter(kind: 'full' | 'typing', lifted: boolean): boolean {
    const frame = this.#frame;
    const { panel, col, coach } = this.#find();
    const stops = panel && col ? this.#ends() : null;
    if (!panel || !col || !stops) return false;
    // The keyboard's strip: the same ends, with the Coach as it is (it doesn't change with the board).
    // The Coach as it is drawn now, exactly, at the end the sheet is at; the keyboard's strip leaves
    // it as it is at both ends (it doesn't change with the board).
    const now = coach?.getBoundingClientRect().height ?? 0;
    const atUp = frame.classList.contains('sheet-full');
    const geo: Stops =
      kind === 'full'
        ? { ...stops, rest: atUp ? stops.rest : { ...stops.rest, coach: now }, up: atUp ? { ...stops.up, coach: now } : stops.up }
        : { ...stops, rest: { ...stops.rest, coach: now }, up: { ...stops.up, coach: now } };
    if (geo.rest.top - geo.up.top < 1) return false;
    const under = col.querySelector<HTMLElement>('.under');
    const bar = col.querySelector<HTMLElement>('.wc-bar');
    const body = panel.querySelector<HTMLElement>(':scope > .panel-body');
    // Read while the layout is still the one drawn (no layout to pay for): where things are and how
    // far the content and the Coach's log are scrolled.
    const wrap = under?.parentElement?.getBoundingClientRect();
    const scrolled = (el: HTMLElement | null | undefined) => (el ? { now: el.scrollTop, content: el.scrollHeight, box: el.clientHeight } : null);
    const bodyAt = scrolled(body);
    this.#logAt = scrolled(coach?.querySelector<HTMLElement>('.log'));
    this.#end = frame.classList.contains('sheet-full') || (kind === 'typing' && Boolean(coach?.querySelector('input.typing')));
    this.#geo = geo;
    this.#kind = kind;
    this.#parts = {
      panel,
      col,
      coach,
      rows: [...(coach?.querySelectorAll<HTMLElement>(':scope > :is(.log-actions, .actions, .thumb-row)') ?? [])],
      board: col.querySelector('.board'),
      under,
      underThere: null,
      bar,
      numbers: [...(bar?.querySelectorAll<HTMLElement>('.percent') ?? [])],
      coords: [...col.querySelectorAll<HTMLElement>('.board .coord')],
      scrolls: [],
    };
    frame.classList.add('v1-moving');
    frame.classList.toggle('v1-faded', frame.classList.contains('sheet-full'));
    col.style.setProperty('--board-max', geo.boardMax);
    col.style.paddingTop = geo.padTop;
    col.style.paddingBottom = geo.padBottom;
    col.style.marginBottom = `${geo.up.col - geo.rest.col}px`;
    // The line under the board, where it wraps differently pulled up: the two cross-fade.
    if (under && wrap && geo.rest.under && geo.up.under && Math.abs(geo.rest.under.height - geo.up.under.height) > 0.5) {
      const there = under.cloneNode(true) as HTMLElement;
      there.setAttribute('aria-hidden', 'true');
      there.removeAttribute('role');
      for (const el of there.querySelectorAll('[role], [aria-live]')) {
        el.removeAttribute('role');
        el.removeAttribute('aria-live');
      }
      Object.assign(there.style, {
        position: 'absolute',
        left: `${geo.up.under.left - wrap.left}px`,
        top: `${geo.up.under.top - wrap.top}px`,
        width: `${geo.up.under.width}px`,
        margin: '0',
        pointerEvents: 'none',
        opacity: '0',
      });
      there.classList.add('v1-under-there');
      under.parentElement?.append(there);
      this.#parts.underThere = there;
    }
    // The content, held where it is scrolled; the room under it keeps it there in the taller box.
    // (The keyboard's strip leaves it where it is.)
    if (body && bodyAt) this.#parts.scrolls.push(kind === 'full' ? this.#scroll(body, bodyAt, geo.rest.body, geo.up.body, '--v1-body-room') : this.#scroll(body, bodyAt, 0, 0, '--v1-body-room'));
    // The Coach laid out as it is now until it is lifted; its height pulled up, as measured.
    this.#natural = now;
    this.#box = now;
    this.#pad = coach ? parseFloat(getComputedStyle(coach).paddingBottom) || 0 : 0;
    this.#upCoach = geo.up.coach;
    this.#ramps = [];
    this.#later = 0;
    if (coach) {
      this.#coachWatch.observe(coach);
      this.#rowWatch.observe(coach, { childList: true });
    }
    this.#lifted = false;
    frame.classList.toggle('v1-rising', !this.#end);
    if (lifted && kind === 'full') this.#lift();
    return true;
  }

  /**
   * The Coach laid out as pulled up: its log as tall as it is then, held where it is scrolled, so
   * the Coach's top edge can rise and fall without what it shows moving under it.
   */
  #lift(): void {
    const parts = this.#parts;
    if (this.#lifted || !parts?.coach || this.#kind !== 'full') return;
    const coach = parts.coach;
    const log = coach.querySelector<HTMLElement>('.log');
    this.#lifted = true;
    const geo = this.#geo!;
    // The Coach's box as tall as it can get (with room for a row the app may add), drawn over the
    // content above it: the content's box and the log's stay as they are, so nothing in them is
    // laid out again (nor the app's own watch on the log, which would take "Read all" away).
    const tall = Math.ceil(Math.max(geo.up.coach, geo.rest.coach, this.#natural) + 64);
    coach.style.minHeight = `${tall}px`;
    coach.style.marginTop = `${this.#natural - tall}px`;
    this.#box = tall;
    this.#frame.classList.add('v1-lifted');
    // The log shows what is under its box too, from where it was scrolled: its lines slide to where
    // the log will be scrolled at the end the sheet comes to.
    if (log && this.#logAt) {
      // Its box held at the size it has now, whatever CoachPanel.svelte's rules say as the app
      // flips `sheet-full` during the move (the value on the log itself, not the screen).
      log.style.setProperty('--v1-log-box', `${this.#logAt.box}px`);
      const s = this.#scroll(log, this.#logAt, geo.rest.log, geo.up.log, null);
      parts.scrolls.push({ ...s, now: 0 });
    }
    // Drawn for the new layout at once, not a frame later.
    this.#draw(this.#run ? this.current() : this.#y);
  }

  /**
   * A box that scrolls, held where it is scrolled now while its box changes size: the room under
   * its content keeps that offset in reach, and its content slides to where it will be scrolled at
   * either end (the browser can't scroll a box further than its content).
   */
  #scroll(el: HTMLElement, at: { now: number; content: number }, restBox: number, upBox: number, room: string | null): Scroll {
    const { now, content } = at;
    // A box of no size: held where it is at both ends.
    const most = (h: number) => (h ? Math.max(0, content - h) : now);
    // Where it is now is where it is at the end it is at; the other end scrolls no further than it can.
    const atUp = this.#end;
    const rest = atUp ? Math.min(now, most(restBox)) : now;
    const up = atUp ? now : Math.min(now, most(upBox));
    // (The browser keeps a box where it is scrolled while that stays in reach: nothing to set.)
    if (room) el.style.setProperty(room, `${Math.max(0, now + Math.max(restBox, upBox) - content) + 4}px`);
    return { el, kids: [...el.children].filter((k): k is HTMLElement => k instanceof HTMLElement), now, rest, up };
  }

  /**
   * Both ends, laid out for a moment each by the class that makes the difference, `sheet-full`
   * (app.css). The Ask box's "Put the answer away" row only shows pulled up, so it is left out at
   * rest. Done ahead of time, while nothing moves.
   */
  #measure(panel: HTMLElement, col: HTMLElement, coach: HTMLElement | null): Stops {
    const frame = this.#frame;
    const hadFull = frame.classList.contains('sheet-full');
    const body = panel.querySelector<HTMLElement>(':scope > .panel-body');
    const log = coach?.querySelector<HTMLElement>('.log') ?? null;
    const read = (): Layout => ({
      top: panel.getBoundingClientRect().top,
      col: col.getBoundingClientRect().height,
      coach: coach?.getBoundingClientRect().height ?? 0,
      log: log?.clientHeight ?? 0,
      body: body?.clientHeight ?? 0,
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
      frame.classList.toggle('sheet-full', false);
      if (row) row.style.display = 'none';
      const style = getComputedStyle(col);
      rest = read();
      boardMax = style.getPropertyValue('--board-max');
      padTop = style.paddingTop;
      padBottom = style.paddingBottom;
      if (row) row.style.display = '';
    };
    const readUp = () => {
      frame.classList.toggle('sheet-full', true);
      up = read();
      // How much "Put the answer away" adds, where it shows: what pulling up makes room for.
      if (row && coach) {
        row.style.display = 'none';
        this.#rowGrowth = up.coach - coach.getBoundingClientRect().height;
        row.style.display = '';
      }
    };
    // No transitions while measuring: with less motion asked for, app.css gives every property a
    // near-zero one, which would leave the other end's layout a frame behind the class.
    frame.classList.add('v1-measuring');
    // The end it is laid out at first, which costs no layout; then the other.
    if (hadFull) {
      readUp();
      readRest();
    } else {
      readRest();
      readUp();
    }
    frame.classList.toggle('sheet-full', hadFull);
    // With those near-zero transitions, settle the restored layout before they come back.
    if (calm()) void panel.offsetTop;
    frame.classList.remove('v1-measuring');
    return { rest: rest!, up: up!, boardMax, padTop, padBottom };
  }

  /** What every moving part is drawn as, for the sheet's top at `y`. */
  #styles(y: number): { el: HTMLElement; style: Record<string, string> }[] {
    const geo = this.#geo!;
    const parts = this.#parts!;
    const { rest, up } = geo;
    const span = rest.top - up.top;
    // How far up it is drawn, 0 at rest and 1 pulled up; past the ends only the panel moves on.
    const p = clamp((rest.top - y) / span, 0, 1);
    const out: { el: HTMLElement; style: Record<string, string> }[] = [{ el: parts.panel, style: { transform: `translate3d(0, ${y - up.top}px, 0)` } }];
    if (parts.coach) {
      // The Coach's top edge rises with the panel from its height at rest to its height pulled up.
      // It is laid out as tall as it gets and slid down by what it shows less (`cut`), its foot past
      // the screen's, while its rows (the Ask box) slide back up to stay docked over its words.
      const shown = lerp(rest.coach, this.#upCoach, p) + this.#ramps.reduce((sum, r) => sum + r.by * clamp((p - r.from) / (1 - r.from || 1), 0, 1), 0);
      out.push({ el: parts.coach, style: { transform: `translate3d(0, ${up.top - y + this.#box - shown}px, 0)` } });
      for (const el of parts.rows) out.push({ el, style: { transform: `translate3d(0, ${shown - this.#natural}px, 0)` } });
    }
    // What the content and the log show: from where they are scrolled at one end to the other.
    for (const s of parts.scrolls) {
      const shift = s.now - lerp(s.rest, s.up, p);
      for (const el of s.kids) out.push({ el, style: { transform: `translate3d(0, ${shift}px, 0)` } });
    }
    const a = rest.board;
    const b = up.board;
    if (parts.board && a && b) {
      const k = lerp(a.width, b.width, p) / a.width;
      out.push({ el: parts.board, style: { transform: `translate3d(${lerp(a.left, b.left, p) - a.left}px, ${lerp(a.top, b.top, p) - a.top}px, 0) scale(${k})` } });
      // The coordinates keep their size, at their corner of the square.
      for (const el of parts.coords) out.push({ el, style: { transform: `scale(${1 / k})` } });
    }
    const ra = rest.bar;
    const rb = up.bar;
    if (parts.bar && ra && rb) {
      const k = lerp(ra.width, rb.width, p) / ra.width;
      out.push({ el: parts.bar, style: { transform: `translate3d(${lerp(ra.left, rb.left, p) - ra.left}px, ${lerp(ra.top, rb.top, p) - ra.top}px, 0) scale(${k}, 1)` } });
      // Its numbers keep their size, at their end of the bar.
      for (const el of parts.numbers) out.push({ el, style: { transform: `translateY(-50%) scale(${1 / k}, 1)` } });
    }
    const ua = rest.under;
    const ub = up.under;
    if (parts.under && ua && ub) {
      // The line under the board keeps its type size: it moves by its centre.
      const cx = lerp(ua.left + ua.width / 2, ub.left + ub.width / 2, p);
      const top = lerp(ua.top, ub.top, p);
      const fade: Record<string, string> = parts.underThere ? { opacity: `${1 - p}` } : {};
      out.push({ el: parts.under, style: { transform: `translate3d(${cx - (ua.left + ua.width / 2)}px, ${top - ua.top}px, 0)`, ...fade } });
      if (parts.underThere) {
        out.push({ el: parts.underThere, style: { transform: `translate3d(${cx - (ub.left + ub.width / 2)}px, ${top - ub.top}px, 0)`, opacity: `${p}` } });
      }
    }
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
    // The fade above the Coach goes as the sheet comes up, and comes back as it goes down.
    this.#frame.classList.toggle('v1-faded', up);
    const steps = 8;
    const frames = Array.from({ length: steps + 1 }, (_, i) => this.#styles(lerp(from, to, i / steps)));
    const run: Run = { from, to, ms, up, elapsed, anims: [] };
    this.#end = up;
    if (up && this.#later && this.#kind === 'full') {
      this.#ramps.push({ from: this.#p(from), by: this.#later });
      this.#later = 0;
    }
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

  #cancel(): void {
    const run = this.#run;
    this.#run = null;
    for (const a of run?.anims ?? []) a.cancel();
  }

  /**
   * What the app is about to remove (or just removed, where it is still drawn) fades out where it
   * was drawn, over the screen, rather than vanishing in one frame.
   */
  #fadeOut(selector: string): void {
    const el = this.#frame.querySelector<HTMLElement>(selector);
    const layout = this.#frame.querySelector<HTMLElement>('.board-layout');
    if (!el || !layout || calm()) return;
    const r = el.getBoundingClientRect();
    const l = layout.getBoundingClientRect();
    if (!r.height) return;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'absolute',
      left: `${r.left - l.left}px`,
      top: `${r.top - l.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      margin: '0',
      zIndex: '7',
      pointerEvents: 'none',
      background: 'var(--panel)',
      transform: 'none',
    });
    ghost.classList.add('v1-ghost');
    layout.append(ghost);
    const from = Number(getComputedStyle(el).opacity) || 0;
    if (!from) return ghost.remove();
    ghost.animate([{ opacity: from }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' }).onfinish = () => ghost.remove();
  }

  /** Back to the real layout, in one step: everything was drawn where that layout puts it. */
  #stop(): void {
    this.#cancel();
    const parts = this.#parts;
    const rowBefore = parts?.coach?.querySelector(':scope > .log-actions') ?? null;
    if (this.#pending !== null) {
      // The app redraws for where the sheet went, now, while nothing moves, and that redraw is laid
      // out together with the end of the move.
      this.#commitFull();
      try {
        flushSync();
      } catch {
        // Called from inside the app's own update: it redraws right after.
      }
    }
    this.#geo = null;
    this.#parts = null;
    this.#ramps = [];
    this.#later = 0;
    this.#lifted = false;
    this.#coachWatch.disconnect();
    this.#rowWatch.disconnect();
    clearTimeout(this.#idle);
    const frame = this.#frame;
    frame.classList.remove('v1-moving', 'v1-lifted', 'v1-faded', 'v1-rising', 'v1-falling');
    this.#rowAimed = false;
    // "Put the answer away", just added pulled up: it fades in over the lines it now covers.
    const rowAfter = parts?.coach?.querySelector<HTMLElement>(':scope > .log-actions');
    if (rowAfter && !rowBefore && !calm()) rowAfter.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
    for (const s of parts?.scrolls ?? []) for (const v of ['--v1-body-room', '--v1-log-box']) s.el.style.removeProperty(v);
    if (parts?.coach) {
      parts.coach.style.minHeight = '';
      parts.coach.style.marginTop = '';
    }
    if (!parts) return;
    const moved = [parts.panel, parts.coach, ...parts.rows, parts.board, parts.under, parts.bar, ...parts.numbers, ...parts.coords, ...parts.scrolls.flatMap((s) => s.kids)];
    for (const el of moved) if (el) el.style.transform = '';
    if (parts.under) parts.under.style.opacity = '';
    parts.underThere?.remove();
    parts.col.style.removeProperty('--board-max');
    parts.col.style.paddingTop = '';
    parts.col.style.paddingBottom = '';
    parts.col.style.marginBottom = '';
    // Each box is left scrolled where its content was drawn: the content as far as it can go at this
    // end, which is where the browser takes it as the room goes; the log, which didn't scroll while
    // lifted, set there.
    const log = parts.coach?.querySelector<HTMLElement>('.log');
    const logScroll = parts.scrolls.find((s) => s.el === log);
    if (log && logScroll) log.scrollTop = this.#end ? logScroll.up : logScroll.rest;
    this.changed();
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
