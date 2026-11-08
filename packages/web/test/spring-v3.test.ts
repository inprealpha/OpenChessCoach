// PROTOTYPE (#80), version 3: the overlay sheet's spring and release rules (lib/sheet-variants/spring-v3.ts).
import { describe, expect, it } from 'vitest';
import { bounded, COMMIT, endsUp, launchVelocity, OMEGA, PROJECT, progress, settled, step, upDetent, velocity } from '../src/lib/sheet-variants/spring-v3.ts';

/** Runs the spring from `x` (offset from the target) with velocity `v` at 60 frames a second. */
function run(x: number, v: number, dt = 1 / 60): { xs: number[]; ms: number } {
  let s = { x, v: launchVelocity(x, v) };
  const xs: number[] = [];
  let t = 0;
  while (!settled(s) && t < 3) {
    s = step(s, dt);
    xs.push(s.x);
    t += dt;
  }
  return { xs, ms: Math.round(t * 1000) };
}

describe('the overlay sheet’s spring', () => {
  it('settles from a tap in about a third of a second, easing in and out, never past the target', () => {
    const { xs, ms } = run(271, 0);
    expect(ms).toBeGreaterThan(250);
    expect(ms).toBeLessThan(500);
    expect(xs.every((x) => x >= 0)).toBe(true);
    // Moving the whole time: every frame closer than the one before.
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeLessThan(xs[i - 1]!);
    // Most of the way in the first 250 ms.
    expect(xs[14]!).toBeLessThan(271 * 0.1);
  });

  it('carries on at the finger’s speed when let go, so the hand-off has no jump in speed', () => {
    // Let go 190 px from the target, moving towards it at 1200 px/s (20 px a frame): the first frame
    // covers about that, the spring adding a little.
    const first = step({ x: 190, v: launchVelocity(190, -1200) }, 1 / 60);
    expect(190 - first.x).toBeGreaterThan(18);
    expect(190 - first.x).toBeLessThan(25);
  });

  it('never bounces past the target, however hard the flick', () => {
    for (const v of [-500, -3000, -8000, -20000]) {
      const { xs } = run(60, v);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    }
    expect(Math.abs(launchVelocity(60, -20000))).toBeLessThanOrEqual(OMEGA * 60);
  });

  it('goes on the same way a frame late or early: a slow frame moves it further, not by a jump', () => {
    const a = step(step({ x: 200, v: 0 }, 1 / 60), 1 / 60);
    const b = step({ x: 200, v: 0 }, 2 / 60);
    expect(a.x).toBeCloseTo(b.x, 6);
  });

  it('let go away from the target, it turns back without stopping dead', () => {
    const { xs } = run(-30, -400);
    expect(Math.min(...xs)).toBeLessThan(-30);
    expect(xs.at(-1)!).toBeCloseTo(0, 0);
  });
});

describe('where the overlay sheet goes when let go', () => {
  const rest = 271;
  it('goes up past 80 px, or a flick of less', () => {
    expect(endsUp(rest - COMMIT - 1, 0, rest, false)).toBe(true);
    expect(endsUp(rest - 40, 0, rest, false)).toBe(false);
    // A short fast flick: 40 px at 1000 px/s carries 150 px further.
    expect(endsUp(rest - 40, -1000, rest, false)).toBe(true);
    // A slow 40 px drag: back to rest.
    expect(endsUp(rest - 40, -100, rest, false)).toBe(false);
  });

  it('comes down the same way, and stays where it is for a drag the other way', () => {
    expect(endsUp(COMMIT + 1, 0, rest, true)).toBe(false);
    expect(endsUp(40, 0, rest, true)).toBe(true);
    expect(endsUp(40, 1000, rest, true)).toBe(false);
    expect(endsUp(-20, -500, rest, true)).toBe(true);
    expect(endsUp(rest + 20, 500, rest, false)).toBe(false);
  });

  it('needs only half the way on a short sheet', () => {
    expect(endsUp(60 - 31, 0, 60, false)).toBe(true);
    expect(PROJECT).toBeCloseTo(0.15);
  });
});

describe('the finger, followed', () => {
  it('moves the sheet one for one between the detents and less and less past them', () => {
    expect(bounded(120, 271)).toBe(120);
    expect(bounded(-40, 271)).toBeGreaterThan(-40);
    expect(bounded(-40, 271)).toBeLessThan(0);
    expect(bounded(-400, 271)).toBeGreaterThan(-60);
    expect(bounded(300, 271)).toBeLessThan(300);
  });

  it('measures its speed over the last 100 ms, and a pause before lifting throws nothing', () => {
    const samples = [0, 16, 32, 48, 64].map((t, i) => ({ t, y: 500 - i * 15 }));
    expect(velocity(samples, 70)).toBeCloseTo(-937.5, 0);
    expect(velocity(samples, 200)).toBe(0);
    // A slow phone's samples, 50 ms apart: still a speed.
    expect(velocity([{ t: 0, y: 500 }, { t: 50, y: 491 }, { t: 100, y: 482 }, { t: 150, y: 473 }], 160)).toBeCloseTo(-180, 0);
  });
});

describe('an up detent as high as the content needs', () => {
  it('rises only as far as the content needs, never past the card’s top, and always some way', () => {
    // A card 400 px tall, at rest 300 px down: content needing 300 px stops 100 px down.
    expect(upDetent(400, 300, 300)).toBe(100);
    // Content needing more than the card: the card's top, the content scrolling inside.
    expect(upDetent(400, 600, 300)).toBe(0);
    // Content that already fits at rest still rises 120 px, so pulling up always shows something.
    expect(upDetent(400, 100, 190)).toBe(70);
    // A slow 40 px drag (100 px/s) on such a sheet falls back; a short flick goes up.
    expect(endsUp(190 - 40, -100, 190, false, 70)).toBe(false);
    expect(endsUp(190 - 40, -1000, 190, false, 70)).toBe(true);
  });

  it('decides on the distance between the detents, wherever up is', () => {
    // Up at 100, rest at 190: half the way is 45 px.
    expect(endsUp(190 - 46, 0, 190, false, 100)).toBe(true);
    expect(endsUp(190 - 40, 0, 190, false, 100)).toBe(false);
    expect(endsUp(100 + 46, 0, 190, true, 100)).toBe(false);
    expect(endsUp(100 + 40, 0, 190, true, 100)).toBe(true);
  });

  it('gives way like a rubber band past up, and tells the Coach how far up the sheet is', () => {
    expect(bounded(80, 190, 100)).toBeGreaterThan(80);
    expect(bounded(80, 190, 100)).toBeLessThan(100);
    expect(progress(190, 190, 100)).toBe(0);
    expect(progress(145, 190, 100)).toBeCloseTo(0.5);
    expect(progress(100, 190, 100)).toBe(1);
    expect(progress(60, 190, 100)).toBe(1);
    expect(progress(230, 190, 100)).toBe(0);
  });
});
