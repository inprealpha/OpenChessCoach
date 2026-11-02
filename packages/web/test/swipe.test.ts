import { describe, expect, it } from 'vitest';
import { afterSwipe, SWIPE } from '../src/lib/swipe.ts';

describe('a swipe on a phone’s panel sheet', () => {
  it('pulls the sheet up when the finger moves up far enough, wherever the panel is scrolled', () => {
    expect(afterSwipe(false, -SWIPE, 0)).toBe(true);
    expect(afterSwipe(false, -SWIPE * 4, 300)).toBe(true);
  });

  it('leaves it down for a tap, a wobble or a swipe down', () => {
    expect(afterSwipe(false, -(SWIPE - 1), 0)).toBe(false);
    expect(afterSwipe(false, SWIPE * 3, 0)).toBe(false);
  });

  it('lets it back down only on a long pull down at the panel’s top, so the panel scrolls back up first', () => {
    expect(afterSwipe(true, SWIPE * 2, 0)).toBe(false);
    expect(afterSwipe(true, SWIPE * 2, 40)).toBe(true);
    expect(afterSwipe(true, SWIPE, 0)).toBe(true);
    expect(afterSwipe(true, -SWIPE * 3, 0)).toBe(true);
  });
});
