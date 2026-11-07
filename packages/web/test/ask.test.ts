// The Ask box names the move a Why Question asks about, as a scoresheet writes it.
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN, playLine } from '@chess-coach/shared/chess';
import { askAbout } from '../src/lib/ask.ts';

describe('askAbout', () => {
  const [e4, e5] = playLine(INITIAL_FEN, ['e2e4', 'e7e5']);
  it('numbers a move by its side', () => {
    expect(askAbout(e4)).toBe('Ask why about 1. e4');
    expect(askAbout(e5)).toBe('Ask why about 1… e5');
  });
  it('asks about the position when there is no move', () => {
    expect(askAbout(undefined)).toBe('Ask about this position');
    expect(askAbout(undefined, true)).toBe('Ask about this position');
  });
  it('is shorter on a phone', () => {
    expect(askAbout(e5, true)).toBe('Why 1… e5?');
  });
});
