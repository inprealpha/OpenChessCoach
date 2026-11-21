// PROTOTYPE (#80), version 3: the physics of the overlay sheet, kept apart from the DOM so it can be
// tested. Positions are the sheet's offset down from the highest it can go, in px; its two detents
// are `up` (as high as its content needs) and `rest`. Velocities are in px/s, positive downwards.

/** The spring's angular frequency: critically damped, it covers 95% of the way in about 240 ms. */
export const OMEGA = 20;
/** A drag starts once the finger has moved this far, so taps stay taps. */
export const SLOP = 8;
/** How far ahead the finger's speed carries the sheet when it is let go, in seconds. */
export const PROJECT = 0.15;
/** Past this many px (or half the way, if less) the sheet goes on to the other detent. */
export const COMMIT = 80;

export interface SpringState {
  /** Offset from the target, px. */
  x: number;
  /** Velocity, px/s. */
  v: number;
}

/**
 * One step of a critically damped spring, solved exactly over `dt` seconds, so a slow frame moves
 * the sheet further rather than leaving it behind. Never passes the target: a step that would cross
 * it stops there.
 */
export function step(s: SpringState, dt: number, omega = OMEGA): SpringState {
  const e = Math.exp(-omega * dt);
  const c = s.v + omega * s.x;
  const x = (s.x + c * dt) * e;
  const v = (s.v - omega * c * dt) * e;
  if (s.x !== 0 && Math.sign(x) !== Math.sign(s.x)) return { x: 0, v: 0 };
  return { x, v };
}

/** Close enough to the target to stop. */
export const settled = (s: SpringState): boolean => Math.abs(s.x) < 0.5 && Math.abs(s.v) < 20;

/**
 * The release velocity the spring starts with: the finger's, except that a critically damped spring
 * thrown at its target faster than `omega * distance` would pass it, so that much is the most it
 * keeps. Away from the target it keeps all of it.
 */
export function launchVelocity(x: number, v: number, omega = OMEGA): number {
  // x is the offset from the target: moving towards it means v has the opposite sign. Let go right
  // on the target, it stays there.
  if (x === 0) return 0;
  if (Math.sign(v) === Math.sign(x)) return v;
  const most = omega * Math.abs(x);
  return Math.sign(v) * Math.min(Math.abs(v), most);
}

/**
 * Whether the sheet ends up when let go at `y` with velocity `v`, having started the gesture up or
 * at rest: its position plus `PROJECT` seconds of the finger's speed decides, past `COMMIT` px or
 * half the way between the detents.
 */
export function endsUp(y: number, v: number, rest: number, wasUp: boolean, up = 0): boolean {
  const ahead = y + v * PROJECT;
  const need = Math.min(COMMIT, (rest - up) / 2);
  return wasUp ? ahead - up < need : rest - ahead > need;
}

/**
 * Past either detent the sheet gives less and less, as a rubber band does: `over` px of finger
 * travel past the end move it at most `limit` px.
 */
export function rubber(over: number, limit = 60): number {
  const k = 0.5;
  const sign = Math.sign(over);
  const a = Math.abs(over);
  return sign * (1 - 1 / ((a * k) / limit + 1)) * limit;
}

/** The sheet's position for a finger at `raw` px (unbounded), with a rubber band past `up` and `rest`. */
export function bounded(raw: number, rest: number, up = 0): number {
  if (raw < up) return up + rubber(raw - up);
  if (raw > rest) return rest + rubber(raw - rest);
  return raw;
}

/**
 * How far the sheet is from rest to up, 0 to 1: what the Coach's size, the dim and the band follow,
 * so they change with the sheet's motion and never in one frame.
 */
export function progress(y: number, rest: number, up: number): number {
  if (rest - up <= 0) return y <= up ? 1 : 0;
  return Math.min(1, Math.max(0, (rest - y) / (rest - up)));
}

/**
 * The up detent: as high as the content needs and no higher, never above 0 (the card's top, which
 * leaves half the board in view), and at least `rise` above rest: a pull up always shows a move, and
 * a slow 40 px drag (less than half of it, with what its speed carries) still falls back to rest.
 */
export function upDetent(card: number, need: number, rest: number, rise = 120): number {
  const fit = card - need;
  return Math.max(0, Math.min(rest - Math.min(rise, rest), fit));
}

/**
 * The finger's speed in px/s from its recent samples: from the last one back over about 100 ms, and
 * at least the one before it, as a slow phone's samples can be further apart. Nothing if the finger
 * stopped before it lifted.
 */
export function velocity(samples: readonly { t: number; y: number }[], now: number): number {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > 100) return 0;
  let i = samples.length - 2;
  if (i < 0) return 0;
  while (i > 0 && last.t - samples[i - 1]!.t <= 100) i--;
  const first = samples[i]!;
  const dt = (last.t - first.t) / 1000;
  return dt > 0 && dt <= 0.25 ? (last.y - first.y) / dt : 0;
}
