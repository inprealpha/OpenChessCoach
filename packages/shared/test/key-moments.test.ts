// Golden tests of the key-moment picker on real Lichess games.
import { describe, expect, it } from 'vitest';
import { isDecided, MAX_KEY_MOMENTS, pickKeyMoments } from '../src/key-moments.ts';
import { gradeRank } from '../src/grader.ts';
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
