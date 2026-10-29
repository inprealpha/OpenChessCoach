// A Review overview's facts, from a real game, and where its text names the game's moves.
import { describe, expect, it } from 'vitest';
import { pickKeyMoments } from '../src/key-moments.ts';
import { gameFacts, namedMoves, overviewSegments } from '../src/overview.ts';
import type { OverviewMove } from '../src/protocol.ts';
import { game } from './golden.ts';

// The seed's game 1: 9… d5 (Black, only move), 11. Bxf7+ and 12. Bg5 (Mistakes), 18. d5 (Inaccuracy).
const D5_BLACK: OverviewMove = { ply: 18, side: 'black', san: 'd5', grade: 'Best', label: '9… d5' };
const BXF7: OverviewMove = { ply: 21, side: 'white', san: 'Bxf7+', grade: 'Mistake', label: '11. Bxf7+' };
const BG5: OverviewMove = { ply: 23, side: 'white', san: 'Bg5', grade: 'Mistake', label: '12. Bg5' };
const D5_WHITE: OverviewMove = { ply: 35, side: 'white', san: 'd5', grade: 'Inaccuracy', label: '18. d5' };
const MOVES = [D5_BLACK, BXF7, BG5, D5_WHITE];

const linked = (text: string, moves = MOVES) => overviewSegments(text, moves).flatMap((s) => (s.move ? [`${s.text}=${s.move.ply}`] : []));

describe('the moves an overview’s text names', () => {
  it('finds each move by its number and SAN, written as a scoresheet writes it or close to it', () => {
    expect(linked('It turned on 11. Bxf7+ and 12.Bg5, after 9… d5 and 9...d5 and 9. ...d5.')).toEqual([
      '11. Bxf7+=21',
      '12.Bg5=23',
      '9… d5=18',
      '9...d5=18',
      '9. ...d5=18',
    ]);
  });

  it('keeps every word of the text, in order, around the moves', () => {
    const text = 'Then 11. Bxf7+ lost the thread, and 18. d5 gave more away.';
    expect(overviewSegments(text, MOVES).map((s) => s.text).join('')).toBe(text);
  });

  it('finds a move written without its check sign, and never a longer move that starts the same', () => {
    expect(linked('After 11. Bxf7 the attack faded.')).toEqual(['11. Bxf7=21']);
    expect(linked('11. Bxf7+e was never played; 12. Bg5xh6 neither.')).toEqual([]);
  });

  it('never takes a move for the other side’s move with the same number', () => {
    // 9. d5 would be White's ninth move: the game's d5 on move 9 is Black's.
    expect(linked('Not 9. d5, and not 18… d5.')).toEqual([]);
  });

  it('finds a move named by SAN alone only when no other move named has that SAN, and only once', () => {
    expect(linked('Bg5 was the second Mistake, and Bg5 again.')).toEqual(['Bg5=23']);
    // Black's 9… d5 and White's 18. d5: "d5" alone could be either.
    expect(linked('The push d5 mattered.')).toEqual([]);
  });

  it('counts the moves of a game set up from a position by that position’s own move numbers', () => {
    const kd3: OverviewMove = { ply: 1, side: 'black', san: 'Kd3', grade: 'Mistake', label: '40… Kd3' };
    expect(linked('It went wrong with 40… Kd3.', [kd3])).toEqual(['40… Kd3=1']);
  });
});

describe('the overview’s facts', () => {
  const g = game('i425hmuv');
  const moments = pickKeyMoments(g.moves, 'white');
  const facts = gameFacts({ opening: g.opening, result: '0-1' }, g.moves, moments);

  it('counts both sides’ Move Grades and gives each key moment the Engine’s best move instead', () => {
    expect(facts.grades.white).toEqual({ Best: 10, Good: 10, Inaccuracy: 2, Mistake: 2 });
    expect(facts.grades.black).toEqual({ Best: 14, Good: 9, Inaccuracy: 1 });
    expect(facts.moments.map((m) => `${m.label} ${m.grade}, better ${m.better?.san}`)).toEqual([
      '11. Bxf7+ Mistake, better axb4',
      '12. Bg5 Mistake, better Ng5',
      '18. d5 Inaccuracy, better Qe2',
      '24. Bxc5 Inaccuracy, better Qxd5',
    ]);
    // The other moves that stood out: not the key moments again.
    expect(facts.standouts.map((m) => `${m.label} ${m.grade}${m.only ? ' only' : ''}`)).toEqual(['9… d5 Best only']);
  });

  it('keeps the moves the guarded reply lists or the text names with their number, and no other', () => {
    expect(namedMoves(facts, 'It turned on 11. Bxf7+.', ['d7d5']).map((m) => m.label)).toEqual(['9… d5', '11. Bxf7+']);
    // A better move isn't one of the game's moves: there is no place in the game to link it to.
    expect(namedMoves(facts, 'axb4 held.', ['a3b4']).map((m) => m.label)).toEqual([]);
  });
});
