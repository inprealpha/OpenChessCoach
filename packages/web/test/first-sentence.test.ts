// A folded Review overview shows its first sentence: move numbers don't end it, other numbers do.
import { describe, expect, it } from 'vitest';
import { firstSentence } from '../src/lib/first-sentence.ts';

describe('firstSentence', () => {
  it('ends at the first full stop', () => {
    expect(firstSentence('Your opening went well. Then it turned.')).toBe('Your opening went well.');
  });
  it('reads past move numbers', () => {
    expect(firstSentence('The game turned on 11. Bxf7+ and 12… Nf6, two Mistakes. Later on.')).toBe('The game turned on 11. Bxf7+ and 12… Nf6, two Mistakes.');
  });
  it('ends at a count or a result', () => {
    expect(firstSentence('White made Inaccuracy 2, Mistake 1, Blunder 0. Black made one.')).toBe('White made Inaccuracy 2, Mistake 1, Blunder 0.');
    expect(firstSentence('You won 1-0. It was close.')).toBe('You won 1-0.');
  });
  it('keeps a move that ends a sentence', () => {
    expect(firstSentence('The best reply was Nf3. You played h3.')).toBe('The best reply was Nf3.');
  });
  it('gives the whole text when it has one sentence', () => {
    expect(firstSentence('  A short game  ')).toBe('A short game');
  });
});
