// Golden tests of Winning Chances on real Lichess positions: the percentage the Player reads
// comes from the Grader's own winning chances, so it always agrees with the Move Grade (ADR 0002).
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN, turnOf } from '../src/chess.ts';
import { GRADE_THRESHOLDS } from '../src/grader.ts';
import { matePhrase, winningChancesFor } from '../src/winning-chances.ts';
import { game, golden } from './golden.ts';

const move = (id: string, ply: number) => {
  const m = game(id).moves[ply - 1];
  if (!m) throw new Error(`No ply ${ply} in ${id}`);
  return m;
};

describe('Winning Chances', () => {
  it('reads an even position as close to 50% for either side', () => {
    // The start position: the Engine's best line is +0.38 for White.
    const m = move('i425hmuv', 1);
    expect(m.fenBefore).toBe(INITIAL_FEN);
    const best = m.candidates[0]?.score ?? { cp: NaN };
    expect(best).toEqual({ cp: 38 });
    const white = winningChancesFor(best, 'white');
    expect(white.side).toBe('white');
    expect(white.percent).toBeCloseTo(53.49, 2);
    expect(white.text).toBe('White’s winning chances: 53%');
    expect(white.short).toBe('53%');
    expect(white.evaluation).toBe('+0.38');
    expect(white.mate).toBeUndefined();
    const black = winningChancesFor(best, 'white', 'black');
    expect(black.percent).toBeCloseTo(46.51, 2);
    expect(black.text).toBe('Black’s winning chances: 47%');
    expect(black.evaluation).toBe('-0.38');
  });

  it('reads a winning position for the side that is winning', () => {
    // 15. Bb3 in iinnkv77: White to move, best line +2.45.
    const m = move('iinnkv77', 29);
    const best = m.candidates[0]?.score ?? { cp: NaN };
    expect(best).toEqual({ cp: 245 });
    expect(winningChancesFor(best, m.side).text).toBe('White’s winning chances: 71%');
    expect(winningChancesFor(best, m.side, 'black').text).toBe('Black’s winning chances: 29%');
  });

  it('reads the key moments of the seeded Italian Game before and after the Player’s move', () => {
    // 11. Bxf7+ (Mistake): the position was 48% for White, the move left 35%.
    const m = move('i425hmuv', 21);
    expect(m.san).toBe('Bxf7+');
    expect(winningChancesFor(m.candidates[0]?.score ?? { cp: NaN }, m.side).text).toBe('White’s winning chances: 48%');
    expect(winningChancesFor(m.playedScore, m.side).text).toBe('White’s winning chances: 35%');
  });

  it('reads a forced mate for the side to move as a mate, not a percentage', () => {
    // 29. Qxg6 in wab4h6cl: White to move mates in 3.
    const m = move('wab4h6cl', 57);
    const best = m.candidates[0]?.score ?? { cp: NaN };
    expect(best).toEqual({ mate: 3 });
    const white = winningChancesFor(best, 'white');
    expect(white.mate).toEqual({ winner: 'white', moves: 3 });
    expect(white.text).toBe('White mates in 3');
    expect(white.short).toBe('White mates in 3');
    expect(white.evaluation).toBe('M3');
    expect(white.percent).toBeGreaterThan(97);
    const black = winningChancesFor(best, 'white', 'black');
    expect(black.text).toBe('White mates in 3');
    expect(black.evaluation).toBe('-M3');
    expect(black.percent).toBeLessThan(3);
  });

  it('reads a forced mate against the side to move as the opponent’s mate', () => {
    // 28… hxg6 in wab4h6cl: Black to move, and White mates in 5 whatever Black plays.
    const m = move('wab4h6cl', 56);
    expect(turnOf(m.fenBefore)).toBe('black');
    const best = m.candidates[0]?.score ?? { cp: NaN };
    expect(best).toEqual({ mate: -5 });
    const black = winningChancesFor(best, 'black');
    expect(black.mate).toEqual({ winner: 'white', moves: 5 });
    expect(black.text).toBe('White mates in 5');
    expect(black.evaluation).toBe('-M5');
  });

  it('names Black when Black mates', () => {
    // Fool's mate: after 1. f3 e5 2. g4, Black mates in 1 with Qh4#.
    expect(turnOf('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2')).toBe('black');
    expect(winningChancesFor({ mate: 1 }, 'black').text).toBe('Black mates in 1');
    expect(winningChancesFor({ mate: 1 }, 'black', 'white').text).toBe('Black mates in 1');
    expect(matePhrase({ winner: 'black', moves: 1 })).toBe('Black mates in 1');
  });

  it('reads a position that is already checkmate as a win', () => {
    expect(winningChancesFor({ mate: 0 }, 'black').text).toBe('White has checkmated');
    expect(winningChancesFor({ mate: 0 }, 'black').percent).toBeLessThan(3);
    // The same checkmate read for the winner, as a bar with White at the bottom does.
    const white = winningChancesFor({ mate: 0 }, 'black', 'white');
    expect(white.text).toBe('White has checkmated');
    expect(white.mate).toEqual({ winner: 'white', moves: 0 });
    expect(white.percent).toBeGreaterThan(97);
  });
});

describe('Winning Chances agree with Move Grades', () => {
  const moves = golden.games.flatMap((g) => g.moves.map((m) => ({ site: g.site, m })));
  const drop = (m: (typeof moves)[number]['m']) =>
    winningChancesFor(m.candidates[0]?.score ?? { cp: NaN }, m.side).percent - winningChancesFor(m.playedScore, m.side).percent;

  it('every Blunder drops the mover’s Winning Chances by at least the Blunder threshold', () => {
    const blunders = moves.filter(({ m }) => m.grade === 'Blunder');
    expect(blunders.length).toBe(11);
    for (const { site, m } of blunders) expect(drop(m), `${site} ply ${m.ply}`).toBeGreaterThanOrEqual(GRADE_THRESHOLDS.Blunder * 50);
  });

  it('every move’s drop in Winning Chances is the winning chance its Move Grade measured', () => {
    for (const { site, m } of moves) {
      if (m.grade === 'Best') continue;
      expect(Math.max(0, drop(m)), `${site} ply ${m.ply}`).toBeCloseTo(m.winLoss * 50, 6);
    }
  });
});
