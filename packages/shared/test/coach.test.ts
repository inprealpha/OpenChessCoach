// The Coach brief budget (ADR 0004) and the Coach-move guard (ADR 0002), each proven to fail on
// a deliberately broken input.
import { describe, expect, it } from 'vitest';
import { assertBriefWithinBudget, BRIEF_BUDGET, BriefTooLargeError, briefSize, buildBrief, profileSlice, type Brief } from '../src/coach/brief.ts';
import { allowedMoves, guardReply } from '../src/coach/guard.ts';
import type { CoachAsk, CoachRawReply } from '../src/coach/types.ts';
import { game } from './golden.ts';

const profile = {
  level: 'casual' as const,
  rating: 1450,
  goals: ['Learn the Italian Game properly', 'Blunder less in the endgame'],
  weaknesses: ['Italian Game: 4 Mistakes in 30 moves'],
  notes: [{ id: 1, text: 'Often trades the Italian bishop too early', createdAt: '2026-01-01' }, { id: 2, text: 'Plays the Caro-Kann as Black', createdAt: '2026-01-01' }],
};

/** A Review moment late in a long real game, the largest brief the app builds. */
function longGameAsk(): CoachAsk {
  const g = game('fzjtms6a');
  const m = g.moves[60];
  if (!m) throw new Error('fixture too short');
  return {
    job: 'review-moment',
    fen: m.fenBefore,
    recentMoves: g.moves.slice(0, 60).map((x) => x.san),
    playerSide: 'white',
    move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
    candidates: m.candidates,
    replies: g.moves[61]?.candidates ?? [],
    question: 'x'.repeat(2000),
    opening: 'Italian Game',
    allowNote: true,
  };
}

describe('the Coach brief', () => {
  it('stays within its budget for a long game, with a huge question and summary', () => {
    const brief = buildBrief({ ask: longGameAsk(), profile, summary: 'y'.repeat(5000) });
    expect(briefSize(brief)).toBeLessThanOrEqual(BRIEF_BUDGET);
    expect(() => assertBriefWithinBudget(brief)).not.toThrow();
  });

  it('the budget check fails on an oversized brief', () => {
    const brief = buildBrief({ ask: longGameAsk(), profile });
    const oversized: Brief = { ...brief, summary: 'z'.repeat(BRIEF_BUDGET) };
    expect(() => assertBriefWithinBudget(oversized)).toThrow(BriefTooLargeError);
  });

  it('carries only the Engine’s judgements: no field for the Coach’s own evaluation', () => {
    const brief = buildBrief({ ask: longGameAsk(), profile });
    expect(Object.keys(brief)).not.toContain('evaluation');
    expect(brief.candidates.length).toBeGreaterThan(0);
    for (const c of brief.candidates) expect(c.eval).toMatch(/^([+-]\d+\.\d\d|-?M\d+|0\.00)$/);
  });

  it('includes only the slice of the Player Profile that matches the topic', () => {
    expect(profileSlice(profile, 'Italian Game')).toEqual({
      goals: ['Learn the Italian Game properly'],
      weaknesses: ['Italian Game: 4 Mistakes in 30 moves'],
      notes: ['Often trades the Italian bishop too early'],
    });
    expect(profileSlice(profile, 'London System')).toBeUndefined();
  });

  it('keeps the recent moves numbered from the current position', () => {
    const g = game('i425hmuv');
    const m = g.moves[6] as (typeof g.moves)[number];
    const brief = buildBrief({ ask: { job: 'why', fen: m.fenBefore, recentMoves: g.moves.slice(0, 6).map((x) => x.san), candidates: m.candidates }, profile });
    expect(brief.recentMoves).toBe('1. e4 e5 2. Bc4 Nc6 3. Nf3 Bc5');
  });
});

describe('the Coach-move guard', () => {
  const g = game('i425hmuv');
  const m = g.moves[20] as (typeof g.moves)[number]; // 11. Bxf7+
  const ask: CoachAsk = {
    job: 'review-moment',
    fen: m.fenBefore,
    recentMoves: [],
    move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
    candidates: m.candidates,
    replies: g.moves[21]?.candidates ?? [],
  };
  const brief = buildBrief({ ask, profile });
  const reply = (over: Partial<CoachRawReply>): CoachRawReply => ({ text: 'x', moves: [], arrows: [], highlights: [], note: null, ...over });

  it('allows the Engine’s candidates, the move itself and the replies to it', () => {
    const allowed = allowedMoves(brief);
    for (const c of brief.candidates) expect(allowed.has(c.uci)).toBe(true);
    expect(allowed.has(m.uci)).toBe(true);
    for (const r of brief.replies ?? []) expect(allowed.has(r.uci)).toBe(true);
  });

  it('strips a legal move the Engine never suggested, and an illegal one', () => {
    const notSuggested = 'h2h3';
    expect(allowedMoves(brief).has(notSuggested)).toBe(false);
    const best = brief.candidates[0]?.uci as string;
    const out = guardReply(brief, reply({ moves: [best, notSuggested, 'e1e8'], arrows: [{ uci: notSuggested, brush: 'red' }, { uci: best, brush: 'green' }] }));
    expect(out.moves).toEqual([best]);
    expect(out.arrows).toEqual([{ from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' }]);
    expect(out.stripped).toHaveLength(3);
  });

  it('strips every move and arrow from a Hint', () => {
    const hint = buildBrief({ ask: { ...ask, job: 'hint' }, profile });
    const best = hint.candidates[0]?.uci as string;
    const out = guardReply(hint, reply({ moves: [best], arrows: [{ uci: best, brush: 'green' }], highlights: ['e4'] }));
    expect(out).toMatchObject({ moves: [], arrows: [], highlights: [] });
  });

  it('keeps a note only when one is allowed, as one short line', () => {
    expect(guardReply(brief, reply({ note: 'Rushes the bishop sacrifice' })).note).toBeNull();
    const allowed = buildBrief({ ask: { ...ask, allowNote: true }, profile });
    const note = guardReply(allowed, reply({ note: `Rushes\n the bishop ${'a'.repeat(200)}` })).note as string;
    expect(note.length).toBeLessThanOrEqual(140);
    expect(note).not.toContain('\n');
  });
});
