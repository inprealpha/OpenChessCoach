import { describe, expect, it } from 'vitest';
import { makeSimplePgn, movesHash, parsePgnGames, parseSinglePgn, PgnImportError, sideOf } from '../src/pgn.ts';
import { PGN_FIXTURES } from './golden.ts';

describe('PGN import', () => {
  it('reads every fixture game with its headers and result', () => {
    const games = parsePgnGames(PGN_FIXTURES);
    expect(games).toHaveLength(8);
    const italian = games.find((g) => g.headers.Site?.endsWith('i425hmuv'));
    expect(italian).toMatchObject({ result: '0-1', finished: true });
    expect(italian?.moves).toHaveLength(48);
    expect(italian?.sans.slice(0, 4)).toEqual(['e4', 'e5', 'Bc4', 'Nc6']);
  });

  it.each([
    ['', 'Paste a PGN first.'],
    ['hello there', 'That PGN has no moves.'],
    ['1. e4 e5 2. Ke3 Nf6 1-0', 'Move 2. Ke3 is not legal in that position.'],
    // Text that can't be a move at all is an illegal move too, never quietly skipped.
    ['1. e4 e5 2. Ke9', 'Move 2. Ke9 is not a legal move.'],
    ['1. e4 e5 2. Nf3 Kz6 3. Bc4 1-0', 'Move 2... Kz6 is not a legal move.'],
    // A knight's move split by a space is not the novelty mark: dropping the "N" would play the pawn move f3.
    ['1. e4 e5 2. N f3 Nc6 3. Bc4 1-0', 'Move 2. N is not a legal move.'],
    ['[Result "1-0"]\n\n1. e4 e5 2. nf3 Nc6 1-0', 'Move 2. nf3 is not a legal move.'],
    ['[Variant "Chess960"]\n\n1. e4 e5 1-0', 'Only standard chess'],
    [`${PGN_FIXTURES}`, 'more than one game'],
  ])('refuses %j with a clear error', (text, message) => {
    expect(() => parseSinglePgn(text)).toThrow(PgnImportError);
    expect(() => parseSinglePgn(text)).toThrow(message);
  });

  it('numbers an illegal move from the [FEN] the game starts at', () => {
    const blackToMove = '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n';
    expect(() => parseSinglePgn(`${blackToMove}1... e5 2. Ke3 *`)).toThrow('Move 2. Ke3 is not legal in that position.');
    expect(() => parseSinglePgn(`${blackToMove}1... Ke7 *`)).toThrow('Move 1... Ke7 is not legal in that position.');
    const move30 = '[SetUp "1"]\n[FEN "6k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 30"]\n\n';
    expect(() => parseSinglePgn(`${move30}30... Kf8 31. Rd7 Ke7 *`)).toThrow('Move 31... Ke7 is not legal in that position.');
  });

  it('reads comments, clock times, NAGs, glyphs and variations without calling them moves', () => {
    const g = parseSinglePgn(
      '[Event "x"]\n[Result "1-0"]\n\n1. e4 {[%clk 0:05:00]} 1... e5!? $1 2.Nf3 (2. Bc4 Nc6) 2... Nc6 ; a line comment\n3. Bb5 a6 +- 4. Ba4 ⩲ 1-0',
    );
    expect(g.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4']);
  });

  it('marks a game still in progress as unfinished', () => {
    expect(parseSinglePgn('[Result "*"]\n\n1. e4 e5 2. Nf3 *').finished).toBe(false);
    expect(parseSinglePgn('1. e4 e5 2. Nf3').finished).toBe(false);
  });

  it.each([
    ['checkmate with no result', '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#', '1-0'],
    ['checkmate marked "*"', '[Result "*"]\n\n1. f3 e5 2. g4 Qh4# *', '0-1'],
    ['stalemate', '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. h4 Rah6 5. Qxc7 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6', '1/2-1/2'],
    ['bare kings', '[FEN "7k/8/8/8/8/8/8/6Kr w - - 0 1"]\n[SetUp "1"]\n\n1. Kxh1 *', '1/2-1/2'],
  ])('takes the result from the board when the moves end the game: %s', (_name, text, result) => {
    expect(parseSinglePgn(text)).toMatchObject({ result, finished: true });
  });

  it.each([
    // The fifty-move rule and repetition must be claimed: the moves alone don't end the game.
    ['the fifty-move count', '[SetUp "1"]\n[FEN "r3k3/8/8/8/8/8/8/R3K3 w - - 98 70"]\n\n70. Ra2 Ra7 71. Ra1 *'],
    ['a threefold repetition', '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8'],
  ])('leaves a game with no result unfinished when only a claimed draw would end it: %s', (_name, text) => {
    expect(parseSinglePgn(text)).toMatchObject({ result: '*', finished: false });
  });

  it('reads "½-½" as a draw, after the moves and in the Result header', () => {
    expect(parseSinglePgn('1. e4 e5 2. Nf3 Nc6 ½-½')).toMatchObject({ result: '1/2-1/2', finished: true });
    expect(parseSinglePgn('[Result "½-½"]\n\n1. e4 e5 2. Nf3 Nc6 ½–½')).toMatchObject({ result: '1/2-1/2', finished: true });
  });

  it('keeps the result a PGN gives, even where the board would say otherwise', () => {
    expect(parseSinglePgn('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 0-1').result).toBe('0-1');
  });

  it('reads "e.p.", the "…" ellipsis and the novelty mark "N" as other sites write them', () => {
    const ep = parseSinglePgn('[FEN "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3"]\n[SetUp "1"]\n\n3. exf6e.p. 1-0');
    expect(ep.sans).toEqual(['exf6']);
    expect(parseSinglePgn('1. e4 1… e5 2. Nf3 N 2…Nc6 1-0').sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    // The novelty mark attached to the move, as ChessBase and books print it; "Ba4N" is no promotion.
    expect(parseSinglePgn('1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4N Nf6 1-0').sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6']);
    expect(parseSinglePgn('1.e4 e5 2.Nf3 Nc6 3.Bb5!N a6 4.O-ON 1-0').sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'O-O']);
    expect(parseSinglePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. Nc3N Be7 6. O-ON 1-0').sans.slice(-3)).toEqual(['Nc3', 'Be7', 'O-O']);
    expect(parseSinglePgn('1.d4 d5 2.c4 e6 3.c5N 3...Nf6 1-0').sans.at(-2)).toBe('c5');
    // "…" counts as Black's move number, so a bad move after it is labelled as Black's.
    expect(() => parseSinglePgn('1. e4 1… e5 2. Nf3 2… Kz6 1-0')).toThrow('Move 2... Kz6 is not a legal move.');
  });

  it('identifies a game by its moves, whatever its headers say', () => {
    const a = parseSinglePgn('[White "a"]\n\n1. e4 e5 2. Nf3 Nc6 1-0');
    const b = parseSinglePgn('[White "b"]\n[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 1-0');
    const c = parseSinglePgn('1. e4 e5 2. Nf3 Nf6 1-0');
    expect(movesHash(a.startFen, a.moves)).toBe(movesHash(b.startFen, b.moves));
    expect(movesHash(a.startFen, a.moves)).not.toBe(movesHash(c.startFen, c.moves));
  });

  it('finds the Player’s side from their username', () => {
    expect(sideOf({ White: 'CoachVerify', Black: 'x' }, 'coachverify')).toBe('white');
    expect(sideOf({ White: 'x', Black: 'CoachVerify' }, 'CoachVerify')).toBe('black');
    expect(sideOf({ White: 'x', Black: 'y' }, 'CoachVerify')).toBeUndefined();
    expect(sideOf({ White: 'x', Black: 'y' }, undefined)).toBeUndefined();
  });

  it('writes a PGN it can read back', () => {
    const pgn = makeSimplePgn({ White: 'You', Black: 'Engine' }, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'], '1-0');
    const g = parseSinglePgn(pgn);
    expect(g.sans).toHaveLength(7);
    expect(g.headers.White).toBe('You');
  });
});
