// PROTOTYPE (#80), version 1: what a drag on the phone's panel sheet does (lib/sheet-variants/swipe-v1.ts).
import { describe, expect, it } from 'vitest';
import { COMMIT, PROJECT, SETTLE_MS, SLOP, ease, follow, heading, hold, owner, settleMs } from '../src/lib/sheet-variants/swipe-v1.ts';

describe('who owns a drag on the sheet', () => {
  it('waits until the finger has moved the slop, so a tap stays a tap', () => {
    expect(owner(false, true, 0, -(SLOP - 1))).toBe('wait');
    expect(owner(true, true, SLOP - 1, SLOP - 1)).toBe('wait');
  });

  it('at rest, gives every vertical drag to the sheet, up or down, wherever the content is scrolled', () => {
    expect(owner(false, true, 0, -SLOP)).toBe('sheet');
    expect(owner(false, false, 2, SLOP * 3)).toBe('sheet');
  });

  it('pulled up, gives the sheet only a drag down that starts with the content at its top; the rest scrolls', () => {
    expect(owner(true, true, 0, SLOP)).toBe('sheet');
    expect(owner(true, false, 0, SLOP)).toBe('scroll');
    expect(owner(true, true, 0, -SLOP)).toBe('scroll');
  });

  it('leaves a sideways drag to nobody', () => {
    expect(owner(false, true, SLOP * 2, SLOP)).toBe('none');
  });

  it('holds the browser back from the first pixel whenever the drag may become the sheet’s', () => {
    expect(hold(false, false, 0, -1)).toBe(true);
    expect(hold(true, true, 0, 1)).toBe(true);
    expect(hold(true, true, 0, -1)).toBe(false);
    expect(hold(true, false, 0, 1)).toBe(false);
    expect(hold(false, true, 3, 1)).toBe(false);
  });
});

describe('the sheet under the finger', () => {
  const top = 275;
  const rest = 447;

  it('moves exactly as far as the finger between its two ends', () => {
    expect(follow(rest, -90, top, rest)).toBe(rest - 90);
    expect(follow(top, 40, top, rest)).toBe(top + 40);
  });

  it('gives less and less past either end, and never more than 60 px', () => {
    const past = follow(rest, 30, top, rest) - rest;
    expect(past).toBeGreaterThan(0);
    expect(past).toBeLessThan(30);
    expect(follow(top, -1000, top, rest)).toBeGreaterThan(top - 60);
  });
});

describe('where the sheet goes when let go', () => {
  it('goes on past 80 px, or half the way if that is less, and comes back short of it', () => {
    expect(heading(false, COMMIT + 1, 0, 400)).toBe(true);
    expect(heading(false, COMMIT - 1, 0, 400)).toBe(false);
    expect(heading(true, 61, 0, 120)).toBe(false);
    expect(heading(true, 59, 0, 120)).toBe(true);
  });

  it('counts about 150 ms of the finger’s speed: a short flick goes, a slow drag comes back', () => {
    // A 40 px flick at 1 px/ms is heading for 190 px.
    expect(heading(false, 40, 1, 172)).toBe(true);
    // A slow 40 px drag, let go still.
    expect(heading(false, 40, 0.05, 172)).toBe(false);
    // Thrown back the way it came: it returns, however far it got.
    expect(heading(false, 120, -1.5, 172)).toBe(false);
    expect(40 + 1 * PROJECT).toBeGreaterThan(COMMIT);
  });
});

describe('the slide into place', () => {
  it('lasts 280 ms, and less for a flick, so it leaves the finger at the finger’s speed', () => {
    expect(settleMs(170, 0)).toBe(SETTLE_MS);
    expect(settleMs(100, 3)).toBeLessThan(SETTLE_MS);
    expect(settleMs(100, 50)).toBe(140);
  });

  it('eases out: quick off the mark, gentle into place, from 0 to 1', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.85);
    // About four times its average speed at the start.
    expect(ease(0.01) / 0.01).toBeGreaterThan(3.5);
    for (let t = 0.05; t < 1; t += 0.05) expect(ease(t)).toBeGreaterThan(ease(t - 0.05));
  });
});
