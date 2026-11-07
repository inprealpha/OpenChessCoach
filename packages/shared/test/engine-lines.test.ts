// The Engine lines as the Board shows them (#52): move numbers as a scoresheet writes them, and
// Winning Chances that are always White's, whoever is to move, as on the bar and the Review's graph.
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN, playLine } from '../src/chess.ts';
import { boardChances, engineLineView, numberedMoves } from '../src/engine-lines.ts';
import { game } from './golden.ts';

const after = (ucis: string[]) => playLine(INITIAL_FEN, ucis).at(-1)!.fenAfter;

describe('Engine lines on the Board', () => {
  it('numbers White’s moves, and Black’s first move with an ellipsis', () => {
    expect(numberedMoves(INITIAL_FEN, ['e2e4', 'e7e5', 'g1f3']).map((m) => m.label)).toEqual(['1. e4', 'e5', '2. Nf3']);
    expect(engineLineView(after(['e2e4']), { pv: ['e7e5', 'g1f3', 'b8c6'], score: { cp: -40 } }).text).toBe('1… e5 2. Nf3 Nc6');
  });

  it('numbers a line from the middle of a real game by the game’s own move number', () => {
    // iinnkv77: White's 14th move, then Black's.
    const moves = game('iinnkv77').moves;
    const white = moves[26]!;
    const black = moves[27]!;
    expect(white.fenBefore.split(' ')[5]).toBe('14');
    const fromWhite = engineLineView(white.fenBefore, { pv: moves.slice(26, 29).map((m) => m.uci), score: { cp: 0 } });
    expect(fromWhite.text).toBe(`14. ${white.san} ${black.san} 15. ${moves[28]!.san}`);
    const fromBlack = engineLineView(black.fenBefore, { pv: moves.slice(27, 29).map((m) => m.uci), score: { cp: 0 } });
    expect(fromBlack.text).toBe(`14… ${black.san} 15. ${moves[28]!.san}`);
    expect(fromBlack.moves.map((m) => m.number)).toEqual(['14…', '15.']);
  });

  it('stops at the first move that isn’t legal, and shows six moves at most', () => {
    expect(numberedMoves(INITIAL_FEN, ['e2e4', 'e2e4']).map((m) => m.san)).toEqual(['e4']);
    const long = engineLineView(INITIAL_FEN, { pv: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6'], score: { cp: 30 } });
    expect(long.text).toBe('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  });

  it('gives White’s Winning Chances when Black is to move, as the bar and the graph do', () => {
    // After 1. e4 in verify mode, Black's best line is -0.37 from Black's side: 47% for Black, so 53% for White.
    const line = engineLineView(after(['e2e4']), { pv: ['e7e6'], score: { cp: -37 } });
    expect(line.chances.side).toBe('white');
    expect(line.chances.short).toBe('53%');
    expect(line.chances.text).toBe('White’s winning chances: 53%');
    expect(line.chances.evaluation).toBe('+0.37');
    // With White to move the same: White's.
    expect(engineLineView(INITIAL_FEN, { pv: ['e2e4'], score: { cp: 38 } }).chances.text).toBe('White’s winning chances: 53%');
  });

  it('reads a mate for Black as next to nothing for White, named as Black’s mate', () => {
    // 1. f3 e5 2. g4: Black to move mates in 1 with Qh4#.
    const line = engineLineView(after(['f2f3', 'e7e5', 'g2g4']), { pv: ['d8h4'], score: { mate: 1 } });
    expect(line.text).toBe('2… Qh4#');
    expect(line.chances.side).toBe('white');
    expect(line.chances.percent).toBeLessThan(5);
    expect(line.chances.text).toBe('Black mates in 1');
    expect(line.chances.evaluation).toBe('-M1');
  });

  it('gives the bar White’s Winning Chances whichever side’s point of view the score is from', () => {
    expect(boardChances({ cp: 245 }, 'white').text).toBe('White’s winning chances: 71%');
    expect(boardChances({ cp: -245 }, 'black').text).toBe('White’s winning chances: 71%');
    expect(boardChances({ cp: 245 }, 'black').text).toBe('White’s winning chances: 29%');
  });
});
