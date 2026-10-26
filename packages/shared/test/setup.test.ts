import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../src/chess.ts';
import { readPosition } from '../src/setup.ts';

describe('setting up the Board from a pasted FEN or PGN', () => {
  it('reads a FEN as the start position, in the library’s own form', () => {
    expect(readPosition('  6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1 \n')).toEqual({ startFen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', moves: [] });
    // An en passant square no pawn can use is dropped, as every later position drops it.
    expect(readPosition('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1').startFen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  it('reads a PGN, with or without headers, as its start position and moves', () => {
    expect(readPosition('1. e4 e5 2. Nf3 Nc6')).toEqual({ startFen: INITIAL_FEN, moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] });
    const headed = readPosition('[Event "Casual"]\n[White "A"]\n[Black "B"]\n\n1. d4 d5 2. c4 *');
    expect(headed.moves).toEqual(['d2d4', 'd7d5', 'c2c4']);
    const fromFen = readPosition('[SetUp "1"]\n[FEN "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"]\n\n1. Rd8# 1-0');
    expect(fromFen).toEqual({ startFen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', moves: ['d1d8'] });
  });

  it('reads a PGN with a [FEN] and no moves, as Lichess exports a lone position, as that position', () => {
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(readPosition(`[Event "Analysis"]\n[SetUp "1"]\n[FEN "${blackToMove}"]\n\n*`)).toEqual({ startFen: blackToMove, moves: [] });
    expect(() => readPosition('[SetUp "1"]\n[FEN "8/8/8/8 w - - 0 1"]\n\n*')).toThrow(/^That FEN isn’t a legal position/);
    // Headers with neither a position nor moves are still no position at all.
    expect(() => readPosition('[Event "Casual"]\n\n*')).toThrow('That PGN has no moves.');
  });

  it('keeps only the castling rights standard chess allows: the king on e1 or e8 and the rook in its corner', () => {
    // A rook on b1 can never castle queenside.
    expect(readPosition('4k3/8/8/8/8/8/8/1R2K2R w KQ - 0 1').startFen).toBe('4k3/8/8/8/8/8/8/1R2K2R w K - 0 1');
    // A king on f1 can never castle.
    expect(readPosition('4k3/8/8/8/8/8/8/R4K1R w KQ - 0 1').startFen).toBe('4k3/8/8/8/8/8/8/R4K1R w - - 0 1');
    expect(readPosition('r3k1r1/8/8/8/8/8/8/4K3 b kq - 0 1').startFen).toBe('r3k1r1/8/8/8/8/8/8/4K3 b q - 0 1');
    expect(readPosition(INITIAL_FEN).startFen).toBe(INITIAL_FEN);
    // So a PGN from such a position can't castle where standard chess can't.
    expect(() => readPosition('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/1R2K2R w KQ - 0 1"]\n\n1. O-O-O *')).toThrow('Move 1. O-O-O is not legal in that position.');
    expect(readPosition('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/1R2K2R w KQ - 0 1"]\n\n1. O-O *').moves).toEqual(['e1g1']);
  });

  it('says plainly what is wrong', () => {
    expect(() => readPosition('   ')).toThrow('Paste a FEN or a PGN first.');
    expect(() => readPosition('8/8/8/8 w - - 0 1')).toThrow(/^That FEN isn’t a legal position/);
    expect(() => readPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w KQkq - 0 1')).toThrow(/^That FEN isn’t a legal position/);
    expect(() => readPosition('hello there')).toThrow(/^That isn’t a FEN or a PGN/);
    expect(() => readPosition('1. e4 e5 2. Ke9')).toThrow('Move 2. Ke9 is not a legal move.');
  });

  it('refuses a FEN with only the board, rather than guess who is to move and who may castle', () => {
    const board = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    expect(() => readPosition(board)).toThrow(`That FEN is missing who is to move or who may castle. Add them after the board, as in “${board} w KQkq - 0 1”: b for Black to move, and - if nobody may castle.`);
    expect(() => readPosition(`${board} b`)).toThrow(/^That FEN is missing who is to move or who may castle/);
    // The move counters can be left out: they change nothing on the board.
    expect(readPosition(`${board} w KQkq`).startFen).toBe(INITIAL_FEN);
    expect(readPosition(`${board}_w_KQkq_-_0_1`).startFen).toBe(INITIAL_FEN);
  });

  it('refuses a position no game can reach: more than 16 pieces, 8 pawns, or the promotions they allow', () => {
    // 16 white pawns.
    expect(() => readPosition('rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toThrow(/^That FEN isn’t a legal position/);
    // A ninth white pawn.
    expect(() => readPosition('rnbqkbnr/pppppppp/8/8/P7/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toThrow(/^That FEN isn’t a legal position/);
    // Three white queens and seven pawns, 16 pieces: one pawn can't have made two queens.
    expect(() => readPosition('rnbqkbnr/pppppppp/8/8/2QQ4/8/1PPPPPPP/RNBQKB1R w KQkq - 0 1')).toThrow(/^That FEN isn’t a legal position/);
    // One promotion: a second queen and seven pawns is a position a game can reach.
    expect(readPosition('rnbqkbnr/pppppppp/8/8/3Q4/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1').startFen).toBe('rnbqkbnr/pppppppp/8/8/3Q4/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(() => readPosition('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n1. a4 *')).toThrow('The PGN’s starting position (FEN header) is not valid.');
  });

  it('says a pasted link is a link, without opening it', () => {
    const link = 'That’s a link, not a FEN or a PGN. Paste the game’s PGN or a FEN instead.';
    expect(() => readPosition('https://lichess.org/q7ZvsdUF')).toThrow(link);
    expect(() => readPosition('  lichess.org/q7ZvsdUF/black ')).toThrow(link);
    expect(() => readPosition('www.chess.com/game/live/123456789')).toThrow(link);
  });
});
