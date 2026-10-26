// Golden tests of a Review's Winning Chances graph on real Lichess games: one point per
// position from White's point of view, with Mistakes and Blunders marked for either side. It is
// drawn from the graded moves a Review already carries, so it needs no Engine run (ADR 0007).
import { describe, expect, it } from 'vitest';
import { winningChancesGraph } from '../src/winning-chances-graph.ts';
import { game } from './golden.ts';

const marks = (id: string) =>
  winningChancesGraph(game(id).moves)
    .filter((p) => p.mark)
    .map((p) => `${p.ply} ${p.mark?.grade} ${p.mark?.side}: ${p.mark?.name}`);

describe('Winning Chances graph', () => {
  it('plots every position of the seeded Italian Game for White, start included', () => {
    const points = winningChancesGraph(game('i425hmuv').moves);
    expect(points).toHaveLength(49);
    expect(points.map((p) => p.ply)).toEqual(Array.from({ length: 49 }, (_, i) => i));
    // The start: the Engine's best line is +0.38 for White.
    expect(points[0]?.percent).toBeCloseTo(53.49, 2);
    expect(points[0]?.label).toBe('Start: White’s winning chances: 53%');
    // 11. Bxf7+ (Mistake) left White 35%, and Black's reply kept it there.
    expect(points[21]?.label).toBe('11. Bxf7+: White’s winning chances: 35%');
    expect(points[22]?.label).toBe('11… Rxf7: White’s winning chances: 35%');
    // The last move, 24… Qxd1, left White at -8.57.
    expect(points[48]?.label).toBe('24… Qxd1: White’s winning chances: 4%');
  });

  it('marks the Player’s two Mistakes in the seeded Italian Game, and nothing else', () => {
    expect(marks('i425hmuv')).toEqual(['21 Mistake white: Mistake by White, move 11', '23 Mistake white: Mistake by White, move 12']);
  });

  it('marks Mistakes and Blunders by both sides, and no Inaccuracies', () => {
    expect(marks('xd9vkd47')).toEqual([
      '16 Mistake black: Mistake by Black, move 8',
      '25 Blunder white: Blunder by White, move 13',
      '30 Blunder black: Blunder by Black, move 15',
      '41 Blunder white: Blunder by White, move 21',
    ]);
  });

  it('numbers moves from the position, for a game that starts with Black to move', () => {
    // xd9vkd47 from 1… onwards, as a Review of a game set up from that position grades it: the
    // first ply is Black's, and the move numbers still follow the scoresheet.
    const points = winningChancesGraph(game('xd9vkd47').moves.slice(1).map((m, i) => ({ ...m, ply: i + 1 })));
    expect(points[0]?.label).toMatch(/^Start: White’s winning chances: \d+%$/);
    expect(points[1]?.label).toMatch(/^1… /);
    expect(points.find((p) => p.mark)?.mark?.name).toBe('Mistake by Black, move 8');
  });

  it('keeps a mate and a huge evaluation on the same 0 to 100 scale as everything else', () => {
    // wab4h6cl reaches +18.27 and then a forced mate, which would flatten a graph of evaluations.
    const points = winningChancesGraph(game('wab4h6cl').moves);
    for (const p of points) {
      expect(p.percent).toBeGreaterThanOrEqual(0);
      expect(p.percent).toBeLessThanOrEqual(100);
    }
    expect(points[57]?.label).toBe('29. Qxg6: White mates in 3');
    expect(points[57]?.percent).toBeGreaterThan(97);
    // 8… Bxf3, Black's Mistake, still shows as a clear dip for Black: White's chances jump.
    const before = points[15]?.percent ?? NaN;
    const after = points[16]?.percent ?? NaN;
    expect(points[16]?.mark?.name).toBe('Mistake by Black, move 8');
    expect(after - before).toBeGreaterThan(10);
  });
});
