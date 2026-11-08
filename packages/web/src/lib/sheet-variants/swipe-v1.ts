// PROTOTYPE (#80), version 1: what a drag on the phone's panel sheet does, apart from the DOM
// (motion-v1.ts draws it). The sheet follows the finger and, let go, goes where it was heading.

/** How far a finger travels before a drag is told from a tap, in CSS pixels. */
export const SLOP = 8;
/** Let go, the sheet goes to the other end once it is heading this far towards it (or half the way, if less). */
export const COMMIT = 80;
/** How far ahead of the finger the sheet is heading: where it is plus this many ms at the finger's speed. */
export const PROJECT = 150;
/** The slide to the end, in ms; a flick that is faster gets a shorter one. */
export const SETTLE_MS = 280;
const SETTLE_MIN_MS = 140;
/** The slide's ease: quick off the mark, gentle into place (the same curve as `EASE`). */
const P1 = [0.2, 0.8] as const;
const P2 = [0.2, 1] as const;
export const EASE = `cubic-bezier(${P1[0]}, ${P1[1]}, ${P2[0]}, ${P2[1]})`;

/** Who owns a drag on the sheet, once the finger has moved `dx`, `dy` (negative: up) from where it touched. */
export type Owner = 'wait' | 'sheet' | 'scroll' | 'none';

/**
 * At rest every vertical drag is the sheet's. Pulled up, the content scrolls, and only a drag
 * down that started with the content at its top is the sheet's. A sideways drag is nobody's.
 */
export function owner(up: boolean, atTop: boolean, dx: number, dy: number): Owner {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return 'wait';
  if (Math.abs(dx) > Math.abs(dy)) return 'none';
  if (!up) return 'sheet';
  return dy > 0 && atTop ? 'sheet' : 'scroll';
}

/**
 * Whether the browser must be stopped from scrolling on this move, before the drag is decided:
 * iOS only lets a page take a touch over on its first move, so anything that may become the
 * sheet's is held from the first pixel.
 */
export function hold(up: boolean, atTop: boolean, dx: number, dy: number): boolean {
  if (Math.abs(dx) > Math.abs(dy)) return false;
  return !up || (dy >= 0 && atTop);
}

/**
 * Where the sheet's top is drawn for a finger `travel` px from where it touched (negative: up),
 * starting from `from`: exactly with the finger between the two ends, `top` (pulled up) and
 * `rest`, and with a rubber band past them.
 */
export function follow(from: number, travel: number, top: number, rest: number): number {
  const y = from + travel;
  if (y < top) return top - band(top - y);
  if (y > rest) return rest + band(y - rest);
  return y;
}

/** A pull past the end: less and less movement for more finger, never more than 60 px. */
function band(over: number): number {
  return 60 * (1 - Math.exp(-over / 120));
}

/**
 * Where the sheet goes when let go: up (true) or down. `toward` is how far the sheet has come
 * from where the drag started towards the other end, `speed` the finger's speed towards it in
 * px/ms, `span` the distance between the two ends.
 */
export function heading(wasUp: boolean, toward: number, speed: number, span: number): boolean {
  const ahead = toward + speed * PROJECT;
  const reach = Math.min(COMMIT, span / 2);
  return ahead > reach ? !wasUp : wasUp;
}

/**
 * How long the slide to the end lasts: `SETTLE_MS`, or shorter for a flick, so the sheet leaves
 * the finger at the finger's speed. The ease starts 4 times faster than its average speed.
 */
export function settleMs(distance: number, speed: number): number {
  const fast = Math.abs(speed) > 0.05 ? (4 * Math.abs(distance)) / Math.abs(speed) : SETTLE_MS;
  return Math.round(Math.max(SETTLE_MIN_MS, Math.min(SETTLE_MS, fast)));
}

/** The ease `EASE` at time `t` (0 to 1): how far along the slide is. */
export function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Solve the curve's x(s) = t for s by Newton's method, then read y(s).
  const bez = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * b * (1 - s) * s * s + s ** 3;
  const slope = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * (1 - s) * s + 3 * (1 - b) * s * s;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const d = slope(P1[0], P2[0], s);
    if (Math.abs(d) < 1e-6) break;
    s -= (bez(P1[0], P2[0], s) - t) / d;
    s = Math.min(1, Math.max(0, s));
  }
  return bez(P1[1], P2[1], s);
}
