// One number per Review position: the Winning Chances bar, the graph and a key moment's card all
// read the score of a position from the same graded move, the one its Move Grade was computed from
// (ADR 0002), so they never disagree.
import { describe, expect, it } from 'vitest';
import { scoreAfterPly } from '../src/position-score.ts';
import { winningChancesGraph } from '../src/winning-chances-graph.ts';
import { winningChancesFor } from '../src/winning-chances.ts';
import { game } from './golden.ts';

const whiteChances = (id: string, ply: number) => {
  const s = scoreAfterPly(game(id).moves, ply);
  return s ? winningChancesFor(s.score, s.pov, 'white') : null;
};

describe('the score of a Review position', () => {
  it('after a move the Engine ranked below its best, is the score that graded that move', () => {
    // 10. a3 (ply 19) was the Engine's fourth line, at -0.20 for White; the next search, one ply
    // deeper, put the position at -0.25. The Move Grade used -0.20, so every view shows -0.20.
    const chances = whiteChances('i425hmuv', 19);
    expect(chances?.evaluation).toBe('-0.20');
    expect(chances?.text).toBe('White’s winning chances: 48%');
    const point = winningChancesGraph(game('i425hmuv').moves)[19];
    expect(point?.label).toBe('10. a3: White’s winning chances: 48%');
    expect(point?.percent).toBe(chances?.percent);
  });

  it('after 12. Bg5, the Player’s Mistake, is White 19% (-3.88), on the graph too', () => {
    const chances = whiteChances('i425hmuv', 23);
    expect(chances?.evaluation).toBe('-3.88');
    expect(chances?.short).toBe('19%');
    expect(winningChancesGraph(game('i425hmuv').moves)[23]?.label).toBe('12. Bg5: White’s winning chances: 19%');
  });

  it('at the start, is the Engine’s best line there', () => {
    expect(whiteChances('i425hmuv', 0)?.evaluation).toBe('+0.38');
  });

  it('after the last move, is that move’s score, and checkmate once it is on the board', () => {
    expect(whiteChances('i425hmuv', 48)?.evaluation).toBe('-8.57');
    // c1n2u39k ends 23. Qd8#.
    const moves = game('c1n2u39k').moves;
    expect(whiteChances('c1n2u39k', moves.length)?.text).toBe('White has checkmated');
    expect(winningChancesGraph(moves).at(-1)?.label).toBe('23. Qd8#: White has checkmated');
  });

  it('is unknown outside the game', () => {
    expect(scoreAfterPly(game('i425hmuv').moves, 49)).toBeNull();
    expect(scoreAfterPly([], 0)).toBeNull();
  });
});
