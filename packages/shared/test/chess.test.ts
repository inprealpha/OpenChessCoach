// How a game ends: the final position decides checkmate, stalemate, insufficient material and the
// fifty-move rule; a threefold repetition needs the whole line, so it is judged from the moves.
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN, outcomeOf, outcomeOfLine, playLine } from '../src/chess.ts';

/** Both sides' king's knights out and back: each round trip returns to the start position. */
const SHUFFLE = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];

describe('outcomeOfLine', () => {
  it('calls the third occurrence of a position a draw by repetition', () => {
    const line = playLine(INITIAL_FEN, [...SHUFFLE, ...SHUFFLE]);
    expect(outcomeOfLine(INITIAL_FEN, line)).toEqual({ winner: undefined, reason: 'repetition' });
  });

  it('plays on after only two occurrences', () => {
    const line = playLine(INITIAL_FEN, [...SHUFFLE, ...SHUFFLE.slice(0, 3)]);
    expect(outcomeOfLine(INITIAL_FEN, line)).toBeUndefined();
    expect(outcomeOfLine(INITIAL_FEN, playLine(INITIAL_FEN, SHUFFLE))).toBeUndefined();
  });

  it('counts a position with an en passant capture available as a different position', () => {
    // 1.e4 Nf6 2.e5 d5: White may take en passant. After the knights' round trips the same pieces
    // stand on the same squares twice more, but the capture is no longer possible.
    const start = playLine(INITIAL_FEN, ['e2e4', 'g8f6', 'e4e5', 'f6g4', 'g1f3', 'd7d5']);
    const fen = start.at(-1)?.fenAfter as string;
    const trips = playLine(fen, ['f3g1', 'g4h6', 'g1f3', 'h6g4', 'f3g1', 'g4h6', 'g1f3', 'h6g4']);
    expect(trips).toHaveLength(8);
    expect(outcomeOfLine(fen, trips)).toBeUndefined();
    const third = playLine(trips.at(-1)?.fenAfter as string, ['f3g1', 'g4h6', 'g1f3', 'h6g4']);
    expect(outcomeOfLine(fen, [...trips, ...third])).toEqual({ winner: undefined, reason: 'repetition' });
  });

  it('gives the final position’s outcome first: a mate on a repeated position is still a mate', () => {
    const fools = playLine(INITIAL_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(outcomeOfLine(INITIAL_FEN, fools)).toEqual({ winner: 'black', reason: 'checkmate' });
  });

  it('is undefined for a game in progress, and for no moves at all', () => {
    expect(outcomeOfLine(INITIAL_FEN, [])).toBeUndefined();
    expect(outcomeOfLine(INITIAL_FEN, playLine(INITIAL_FEN, ['e2e4', 'e7e5']))).toBeUndefined();
  });

  it('counts the start position however its FEN is written', () => {
    // After 1. e4 a FEN often names e3 for en passant, though no Black pawn can take there; the
    // positions played from it never name it, so the start must be read the same way.
    const start = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const line = playLine(start, ['g8f6', 'g1f3', 'f6g8', 'f3g1', 'g8f6', 'g1f3', 'f6g8', 'f3g1']);
    expect(line).toHaveLength(8);
    expect(outcomeOfLine(start, line)).toEqual({ winner: undefined, reason: 'repetition' });
  });
});

describe('outcomeOf', () => {
  it('ends the game by the fifty-move rule and on insufficient material', () => {
    expect(outcomeOf('8/8/4k3/8/8/4K3/4R3/8 w - - 100 80')).toEqual({ winner: undefined, reason: 'draw' });
    expect(outcomeOf('8/8/4k3/8/8/4K3/4N3/8 w - - 0 80')).toEqual({ winner: undefined, reason: 'insufficient' });
    expect(outcomeOf('8/8/4k3/8/8/4K3/4R3/8 w - - 99 80')).toBeUndefined();
  });
});
