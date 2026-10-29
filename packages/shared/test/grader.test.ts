// Golden tests of Move Grades on real Lichess positions (ADR 0002, ADR 0006).
import { describe, expect, it } from 'vitest';
import { gradeFromAnalyses } from '../src/analysis.ts';
import { INITIAL_FEN, playLine } from '../src/chess.ts';
import type { Analysis, Score } from '../src/engine.ts';
import { formatScore, gradeMove, scoreToCp, winningChances } from '../src/grader.ts';
import { game, golden } from './golden.ts';

describe('winning chances', () => {
  it('follows the Lichess curve', () => {
    expect(winningChances({ cp: 0 })).toBe(0);
    expect(winningChances({ cp: 100 })).toBeCloseTo(0.1821, 4);
    expect(winningChances({ cp: -300 })).toBeCloseTo(-0.5023, 4);
    // Capped at ±1000 centipawns, and mates count as more than any centipawn score.
    expect(winningChances({ cp: 5000 })).toBe(winningChances({ cp: 1000 }));
    expect(scoreToCp({ mate: 1 })).toBeGreaterThan(scoreToCp({ cp: 1000 }));
    expect(scoreToCp({ mate: -3 })).toBeLessThan(scoreToCp({ cp: -1000 }));
  });

  it('formats scores from the side to move', () => {
    expect(formatScore({ cp: 45 })).toBe('+0.45');
    expect(formatScore({ cp: -120 })).toBe('-1.20');
    expect(formatScore({ mate: 3 })).toBe('M3');
  });
});

describe('Move Grade thresholds', () => {
  const best = { cp: 0 };
  it.each([
    [{ cp: 0 }, true, 'Best'],
    [{ cp: -40 }, false, 'Good'],
    [{ cp: -60 }, false, 'Inaccuracy'],
    [{ cp: -120 }, false, 'Mistake'],
    [{ cp: -200 }, false, 'Blunder'],
    [{ mate: -2 }, false, 'Blunder'],
  ] as const)('%o graded against an equal position is %s', (played, isTopMove, grade) => {
    expect(gradeMove({ best, played, isTopMove }).grade).toBe(grade);
  });
});

describe('a move that gives checkmate', () => {
  it('is Best, though the Engine lists another mate first', () => {
    expect(gradeMove({ best: { mate: 1 }, played: { mate: 1 }, isTopMove: false })).toEqual({ grade: 'Best', winLoss: 0 });
  });

  it('is Best when the Engine’s line mates in more moves, or it never listed the move', () => {
    // King and queen against king: Qg7# and Qd8# both mate at once; the Engine lists Qg7# alone.
    const fen = '6k1/8/5QK1/8/8/8/8/8 w - - 0 1';
    const before: Analysis = { fen, depth: 10, lines: [{ depth: 10, score: { mate: 1 }, pv: ['f6g7'] }] };
    expect(gradeFromAnalyses(1, 'f6g7', before, undefined).grade).toBe('Best');
    expect(gradeFromAnalyses(1, 'f6d8', before, undefined).grade).toBe('Best');
    expect(gradeMove({ best: { mate: 2 }, played: { mate: 1 }, isTopMove: false }).grade).toBe('Best');
  });
});

describe('the material floor', () => {
  it('grades hanging a piece a queen down at least Mistake, though the winning chance barely moves', () => {
    // Ba6 a queen down: the best move keeps it at -9, Ba6 drops a bishop on top.
    const input = { best: { cp: -900 }, played: { cp: -1230 }, isTopMove: false };
    expect(gradeMove(input).winLoss).toBeLessThan(0.1);
    expect(gradeMove(input).grade).toBe('Mistake');
  });

  it('flags giving up three pawns of evaluation in a won position too', () => {
    expect(gradeMove({ best: { cp: 1500 }, played: { cp: 1150 }, isTopMove: false }).grade).toBe('Mistake');
  });

  it('leaves smaller losses in a decided position to the winning-chance formula', () => {
    expect(gradeMove({ best: { cp: -900 }, played: { cp: -1150 }, isTopMove: false }).grade).toBe('Good');
  });

  it('never softens a worse grade', () => {
    expect(gradeMove({ best: { cp: 0 }, played: { cp: -400 }, isTopMove: false }).grade).toBe('Blunder');
  });
});

describe('a slower mate', () => {
  /** An analysis of a position from its lines' first moves and scores, as the Engine reported them. */
  const analysis = (fen: string, lines: [string, Score][]): Analysis => ({ fen, depth: 10, lines: lines.map(([uci, score]) => ({ pv: [uci], score, depth: 10 })) });
  // King and rook against king: Ra8 mates at once. The desktop's Stockfish at verify mode's depth
  // (10, five lines) reported these lines before the move and after it.
  const rook = analysis('7k/8/6K1/8/8/8/8/R7 w - - 0 1', [['a1a8', { mate: 1 }], ['a1b1', { mate: 2 }], ['a1c1', { mate: 2 }], ['a1a2', { mate: 2 }], ['a1a3', { mate: 2 }]]);

  it('is Good when the move still forces mate: nothing is given away (Lichess never faults a delayed mate)', () => {
    // 1. Kf6 still mates in 4 and 1. Kg5 in 6; mapped to centipawns they sit 300 and 500 below mate in 1.
    const kf6 = gradeFromAnalyses(1, 'g6f6', rook, analysis('7k/8/5K2/8/8/8/8/R7 b - - 1 1', [['h8g8', { mate: -4 }]]));
    const kg5 = gradeFromAnalyses(1, 'g6g5', rook, analysis('7k/8/8/6K1/8/8/8/R7 b - - 1 1', [['h8g7', { mate: -6 }]]));
    expect([kf6.grade, kf6.winLoss, kg5.grade, kg5.winLoss]).toEqual(['Good', 0, 'Good', 0]);
    expect(gradeMove({ best: { mate: 2 }, played: { mate: 5 }, isTopMove: false }).grade).toBe('Good');
  });

  it('keeps the material floor for a move that lets the mate go', () => {
    // King and queen: Qb8 mates at once; 1. Kg5 leaves White winning (+10.12) but with no mate in sight.
    const queen = analysis('7k/8/6K1/8/8/8/8/1Q6 w - - 0 1', [['b1b8', { mate: 1 }], ['b1a1', { mate: 2 }], ['b1c1', { mate: 2 }], ['b1h1', { mate: 2 }], ['b1d1', { mate: 2 }]]);
    const kg5 = gradeFromAnalyses(1, 'g6g5', queen, analysis('7k/8/8/6K1/8/8/8/1Q6 b - - 1 1', [['h8g7', { cp: -1012 }]]));
    expect([kg5.grade, kg5.winLoss]).toEqual(['Mistake', 0]);
    expect(gradeMove({ best: { mate: 3 }, played: { cp: 900 }, isTopMove: false }).grade).toBe('Mistake');
  });
});

describe('golden games', () => {
  it(`were graded by ${golden.engine}`, () => {
    expect(golden.games).toHaveLength(8);
  });

  it('every stored Move Grade follows from its own Engine facts', () => {
    for (const g of golden.games) {
      for (const m of g.moves) {
        const lines = m.candidates.map((c) => ({ pv: c.pv, score: c.score, depth: 10 }));
        const after = { fen: m.fenAfter, depth: 10, lines: [{ pv: ['0000'], score: 'mate' in m.playedScore && m.playedScore.mate !== undefined ? { mate: -m.playedScore.mate } : { cp: -(m.playedScore as { cp: number }).cp }, depth: 10 }] };
        expect(gradeFromAnalyses(m.ply, m.uci, { fen: m.fenBefore, depth: 10, lines }, after).grade, `${g.site} ply ${m.ply}`).toBe(m.grade);
      }
    }
  });

  it('grades a sound fourth-best move Good, not as an error', () => {
    // 2. Bc4 in the Italian Game (i425hmuv): the Engine's fourth choice, and a perfectly good move.
    const m = game('i425hmuv').moves[2];
    expect(m?.san).toBe('Bc4');
    expect(m?.candidates.findIndex((c) => c.uci === m.uci)).toBe(3);
    expect(m?.grade).toBe('Good');
  });

  it('finds the known blunders', () => {
    const blunders = (id: string) => game(id).moves.filter((m) => m.grade === 'Blunder').map((m) => `${m.ply}:${m.san}`);
    expect(blunders('wvkkfh56')).toEqual(['13:Nd5', '31:Qe2']);
    expect(blunders('xd9vkd47')).toEqual(['25:f3', '30:Bxe4', '41:Qxe3']);
    expect(blunders('i425hmuv')).toEqual([]);
  });

  it('grades the opening book moves of the Italian Game Best or Good', () => {
    for (const m of game('i425hmuv').moves.slice(0, 8)) expect(['Best', 'Good'], `${m.ply}:${m.san}`).toContain(m.grade);
  });
});

describe('a move that ends the game in a draw', () => {
  /** The verify-mode Engine's lines (depth 10, 5 lines) on a bare position, which shows no repetition. */
  const analysis = (fen: string, lines: [string, Score][]): Analysis => ({ fen, depth: 10, lines: lines.map(([uci, score]) => ({ pv: [uci], score, depth: 10 })) });
  // 1. e4 e5 2. Qh5 Qg5 3. Qxg5, then both knights out and back twice: White is a queen up.
  const SHUFFLE = ['e2e4', 'e7e5', 'd1h5', 'd8g5', 'h5g5', 'b8c6', 'g1f3', 'c6b8', 'f3g1', 'b8c6', 'g1f3', 'c6b8'];
  const queenUp = analysis('rnb1kbnr/pppp1ppp/8/4p1Q1/4P3/5N2/PPPP1PPP/RNB1KB1R w KQkq - 7 7', [
    ['g5e5', { cp: 710 }],
    ['h2h4', { cp: 698 }],
    ['a2a4', { cp: 693 }],
    ['g5g3', { cp: 684 }],
    ['d2d4', { cp: 665 }],
  ]);
  const afterNg1 = analysis('rnb1kbnr/pppp1ppp/8/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 8 7', [['h7h5', { cp: -640 }]]);

  it('scores the third occurrence of a position as a draw: a queen up, 7. Ng1 throws the win away', () => {
    const game = { startFen: INITIAL_FEN, moves: playLine(INITIAL_FEN, SHUFFLE) };
    const g = gradeFromAnalyses(13, 'f3g1', queenUp, afterNg1, game);
    expect(g.playedScore).toEqual({ cp: 0 });
    expect(g.grade).toBe('Blunder');
    // The bare positions alone can't tell: they read it as keeping the queen.
    expect(gradeFromAnalyses(13, 'f3g1', queenUp, afterNg1).grade).toBe('Good');
  });

  it('a queen down, the repetition is the best move there is', () => {
    const game = { startFen: INITIAL_FEN, moves: playLine(INITIAL_FEN, [...SHUFFLE, 'f3g1']) };
    const queenDown = analysis(afterNg1.fen, [
      ['h7h5', { cp: -640 }],
      ['g8f6', { cp: -642 }],
      ['a7a5', { cp: -648 }],
      ['b8c6', { cp: -651 }],
      ['b8a6', { cp: -656 }],
    ]);
    const g = gradeFromAnalyses(14, 'b8c6', queenDown, undefined, game);
    expect(g.grade).toBe('Best');
    expect(g.candidates.map((c) => [c.san, c.score])).toEqual([
      ['Nc6', { cp: 0 }],
      ['h5', { cp: -640 }],
      ['Nf6', { cp: -642 }],
      ['a5', { cp: -648 }],
      ['Na6', { cp: -656 }],
    ]);
  });

  it('scores a move that ends the game by the fifty-move rule as a draw too', () => {
    // 121. Qg7# mates; any other Queen move is the hundredth half-move without a capture or a pawn move.
    const fen = '7k/8/5K2/8/8/8/8/6Q1 w - - 99 120';
    const before = analysis(fen, [['g1g7', { mate: 1 }], ['g1d1', { cp: 0 }]]);
    const g = gradeFromAnalyses(1, 'g1d1', before, undefined, { startFen: fen, moves: [] });
    expect(g.playedScore).toEqual({ cp: 0 });
    expect(g.grade).toBe('Blunder');
  });
});
