// Golden tests of the key-moment and standout-move pickers on real Lichess games.
import { describe, expect, it } from 'vitest';
import { isDecided, MAX_KEY_MOMENTS, MAX_STANDOUTS, pickKeyMoments, pickStandouts } from '../src/key-moments.ts';
import { GRADE_THRESHOLDS, gradeRank, isBadGrade, MOVE_GRADES, winningChances } from '../src/grader.ts';
import { game, golden } from './golden.ts';

const picked = (id: string, side: 'white' | 'black') => pickKeyMoments(game(id).moves, side).map((m) => `${m.ply}:${m.san}:${m.grade}`);

describe('key moments', () => {
  it('picks the Player’s worst moves in game order', () => {
    expect(picked('i425hmuv', 'white')).toEqual(['21:Bxf7+:Mistake', '23:Bg5:Mistake', '35:d5:Inaccuracy', '47:Bxc5:Inaccuracy']);
    expect(picked('xd9vkd47', 'white')).toEqual(['9:e3:Inaccuracy', '11:c5:Inaccuracy', '25:f3:Blunder', '33:Qe2:Inaccuracy', '41:Qxe3:Blunder']);
    expect(picked('ydbin4d9', 'black')).toEqual(['16:Nd5:Inaccuracy', '28:O-O-O:Mistake', '30:hxg6:Inaccuracy', '32:Nf6:Blunder', '34:Bd6:Inaccuracy']);
  });

  it('picks fewer when the game had fewer real mistakes', () => {
    expect(picked('c1n2u39k', 'white')).toEqual(['25:Be2:Inaccuracy']);
    expect(picked('i425hmuv', 'black')).toEqual(['32:Nc6:Inaccuracy']);
  });

  it('never picks more than five, never the opponent’s moves, never a decided position', () => {
    for (const g of golden.games) {
      for (const side of ['white', 'black'] as const) {
        const moments = pickKeyMoments(g.moves, side);
        expect(moments.length).toBeLessThanOrEqual(MAX_KEY_MOMENTS);
        for (const m of moments) {
          expect(m.side).toBe(side);
          expect(gradeRank(m.grade)).toBeGreaterThanOrEqual(gradeRank('Inaccuracy'));
          expect(isDecided(m)).toBe(false);
        }
        expect(moments.map((m) => m.ply)).toEqual([...moments.map((m) => m.ply)].sort((a, b) => a - b));
      }
    }
  });

  it('ranks by winning chance lost when there are more than five candidates', () => {
    const g = game('xd9vkd47');
    const all = g.moves.filter((m) => m.side === 'white' && gradeRank(m.grade) >= gradeRank('Inaccuracy') && !isDecided(m));
    const chosen = pickKeyMoments(g.moves, 'white');
    const threshold = Math.min(...chosen.map((m) => m.winLoss));
    for (const m of all) if (!chosen.includes(m)) expect(m.winLoss).toBeLessThanOrEqual(threshold);
  });
});

const standouts = (id: string, except: number[] = []) =>
  pickStandouts(game(id).moves, new Set(except)).map((s) => `${s.move.ply}:${s.move.san}:${s.move.grade}${s.only ? ':only' : ''}`);

describe('standout moves', () => {
  it('picks both sides’ Mistakes and Blunders and the only good moves, in game order', () => {
    expect(standouts('i425hmuv')).toEqual(['18:d5:Best:only', '21:Bxf7+:Mistake', '23:Bg5:Mistake']);
    expect(standouts('xd9vkd47')).toEqual(['16:Qd7:Mistake', '25:f3:Blunder', '30:Bxe4:Blunder', '41:Qxe3:Blunder', '42:Qxg2+:Best:only']);
    expect(standouts('ydbin4d9')).toEqual(['23:Bxf4:Best:only', '28:O-O-O:Mistake', '31:Rae1:Blunder', '32:Nf6:Blunder', '33:Ne5:Best:only', '35:Nxf7:Best:only']);
  });

  it('leaves out the key moments it is told to, which a Review lists already', () => {
    expect(standouts('i425hmuv', [21, 23, 35, 47])).toEqual(['18:d5:Best:only']);
  });

  it('never calls a recapture an only move, however much worse the other moves are', () => {
    // 11… Rxf7 takes back the bishop that took on f7: the Engine's best by far, and the natural move.
    const g = game('i425hmuv');
    const rxf7 = g.moves[21];
    const [best, next] = rxf7?.candidates ?? [];
    expect(rxf7).toMatchObject({ ply: 22, san: 'Rxf7', grade: 'Best', uci: best?.uci });
    expect(winningChances(best!.score) - winningChances(next!.score)).toBeGreaterThanOrEqual(GRADE_THRESHOLDS.Mistake);
    expect(pickStandouts(g.moves).map((s) => s.move.ply)).not.toContain(22);
  });

  it('holds to the Engine’s facts on every golden game: no new Move Grade, at most eight, never a decided position', () => {
    // There is no Brilliant: an only move is graded Best, the top of the Move Grades (ADR 0002).
    expect(MOVE_GRADES[0]).toBe('Best');
    for (const g of golden.games) {
      const picked = pickStandouts(g.moves);
      expect(picked.length).toBeLessThanOrEqual(MAX_STANDOUTS);
      expect(picked.map((s) => s.move.ply)).toEqual(picked.map((s) => s.move.ply).sort((a, b) => a - b));
      for (const { move, only } of picked) {
        expect(isDecided(move)).toBe(false);
        if (!only) expect(isBadGrade(move.grade)).toBe(true);
        else {
          const [best, next] = move.candidates;
          expect(move.grade).toBe('Best');
          expect(move.uci).toBe(best?.uci);
          expect(winningChances(best!.score) - winningChances(next!.score)).toBeGreaterThanOrEqual(GRADE_THRESHOLDS.Mistake);
        }
      }
      // With room for them all, every Mistake and Blunder of an undecided game is there.
      const errors = g.moves.filter((m) => isBadGrade(m.grade) && !isDecided(m));
      if (picked.length < MAX_STANDOUTS) for (const m of errors) expect(picked.map((s) => s.move)).toContain(m);
    }
  });
});
