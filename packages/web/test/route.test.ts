// The hash router's reading of a link: a screen, its parameters and, for #/board?fen=…, a query.
import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/lib/route.ts';

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

describe('reading a link into a route', () => {
  it('reads a screen and its parameters, with an empty query', () => {
    expect(parseRoute('#/review/12')).toEqual({ name: 'review', params: ['12'], query: {} });
    expect(parseRoute('#/lesson/italian-game')).toEqual({ name: 'lesson', params: ['italian-game'], query: {} });
    expect(parseRoute('')).toEqual({ name: '', params: [], query: {} });
  });

  it('reads the Board’s ?fen= whichever way the spaces are written', () => {
    expect(parseRoute(`#/board?fen=${encodeURIComponent(FEN)}`)).toEqual({ name: 'board', params: [], query: { fen: FEN } });
    expect(parseRoute(`#/board?fen=${FEN.replaceAll(' ', '+')}`).query.fen).toBe(FEN);
    // Lichess writes "_" between a FEN's fields; the FEN reader takes that as it is.
    expect(parseRoute(`#/board?fen=${FEN.replaceAll(' ', '_')}`).query.fen).toBe(FEN.replaceAll(' ', '_'));
  });

  it('opens the pairing link (#pair=CODE) at the root, with no query', () => {
    expect(parseRoute('#pair=6PMAU8F7S8CC')).toEqual({ name: '', params: [], query: {} });
  });
});
