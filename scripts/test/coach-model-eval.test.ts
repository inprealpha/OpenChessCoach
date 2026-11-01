// The Haiku-versus-Sonnet measurement's own logic (#34): what it flags in a Hint, how it hides
// which model wrote what from the final judge, and how it counts the judges' verdicts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import { finalTally, hintFlags, pairs, summarize, type FinalVerdict, type JudgedAnswer, type ModelAnswer, type ModelEvalPosition, type Verdict } from '../coach-model-eval.ts';
import type { PlayerLevel } from '@chess-coach/shared/protocol';

const brief = (job: 'hint' | 'live'): Brief =>
  ({
    job, level: 'beginner', sideToMove: 'black', fen: 'r5k1/P1R3pp/3r4/4N3/3P4/1p2P3/1P2n1PK/R7 b - - 0 34', recentMoves: '34. a7',
    candidates: [{ san: 'Rh6#', uci: 'd6h6', evaluation: 'M1', grade: 'Best', line: '' }], maxWords: 40, allowNote: false, hideMoves: job === 'hint',
  }) as Brief;

describe('hintFlags', () => {
  it('flags a named move and the best move’s square', () => {
    expect(hintFlags('Play Rh6#, it mates.', brief('hint'))).toEqual({ namesMove: ['Rh6'], namesBestSquare: true });
    expect(hintFlags('Your rook can go to h6.', brief('hint'))).toEqual({ namesMove: [], namesBestSquare: true });
    expect(hintFlags('Think about …xh6 here.', brief('hint')).namesBestSquare).toBe(true);
    expect(hintFlags('Look at the h6-square and the h7 pawn.', brief('hint')).namesBestSquare).toBe(true);
    expect(hintFlags('Look at the h66 file.', brief('hint')).namesBestSquare).toBe(false);
  });

  it('leaves a Hint that only points at the idea alone', () => {
    expect(hintFlags('Look at White’s king: which of your pieces can reach it with check?', brief('hint'))).toEqual({ namesMove: [], namesBestSquare: false });
  });
});

const answer = (id: string, level: PlayerLevel, job: 'hint' | 'live', extra: Partial<ModelAnswer> = {}): ModelAnswer => ({
  id, job, level, model: 'haiku', brief: brief(job), reply: { text: 'x', moves: [], arrows: [], highlights: [], note: null, stripped: 0, model: 'haiku', engineQuestions: 0 }, ms: 1000, words: 30, ...extra,
});

describe('pairs', () => {
  const judged = (round: string, id: string): JudgedAnswer => ({ key: `${round}-${id}`, id, job: 'hint', level: 'club', text: round, arrows: [], brief: brief('hint') });
  const a = { round: 'R1', engine: {}, answers: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => judged('R1', id)) };
  const b = { round: 'R2', answers: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => judged('R2', id)) };

  it('puts the same position and level side by side, in an order that is fixed but not always the first round first', () => {
    const out = pairs(a, b).pairs;
    expect(out).toHaveLength(6);
    for (const p of out) expect([p.A.text, p.B.text].sort()).toEqual(['R1', 'R2']);
    expect(new Set(out.map((p) => p.A.text)).size).toBe(2);
    expect(pairs(a, b)).toEqual(pairs(a, b));
  });

  it('never shows the model', () => {
    expect(JSON.stringify(pairs(a, b))).not.toMatch(/haiku|sonnet/i);
  });
});

describe('summarize', () => {
  it('counts each job’s verdicts by the keys the packet gave the answers', () => {
    const answers = [
      answer('h1', 'beginner', 'hint', { ms: 2000 }),
      answer('h2', 'casual', 'hint', { ms: 4000, words: 45 }),
      answer('l1', 'club', 'live', { ms: 3000 }),
      answer('l2', 'club', 'live', { reply: undefined, error: 'boom' }),
    ];
    const verdicts: Verdict[] = [
      { key: 'R1-001', falseClaims: [{ claim: 'c', why: 'w' }, { claim: 'd', why: 'w' }], missesMainPoint: false, givesAway: true, fitsLevel: true, sense: 'ok' },
      { key: 'R1-002', falseClaims: [], missesMainPoint: true, givesAway: false, fitsLevel: false, sense: 'good' },
      { key: 'R1-003', falseClaims: [{ claim: 'e', why: 'w' }], missesMainPoint: false, givesAway: null, fitsLevel: true, sense: 'poor' },
    ];
    const rows = summarize(answers, verdicts, ['R1-001', 'R1-002', 'R1-003', 'R1-004']);
    expect(rows.hint).toMatchObject({ answers: 2, judged: 2, falseClaims: 2, answersWithFalseClaim: 1, givesAway: 1, missesMainPoint: 1, misfitsLevel: 1, good: 1, overWordBudget: 1, medianMs: 3000 });
    expect(rows.live).toMatchObject({ answers: 2, errors: 1, judged: 1, falseClaims: 1, poor: 1, medianMs: 3000 });
    expect(rows.live).not.toHaveProperty('givesAway');
  });
});

describe('the position set', () => {
  const positions = JSON.parse(readFileSync(new URL('../coach-model-positions.json', import.meta.url), 'utf8')) as ModelEvalPosition[];

  it('has 15 Hints and 15 Live Coaching moments, each Live one with the Player’s move', () => {
    expect(positions.filter((p) => p.job === 'hint')).toHaveLength(15);
    const live = positions.filter((p) => p.job === 'live');
    expect(live).toHaveLength(15);
    for (const p of live) expect(p.moveUci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    expect(new Set(positions.map((p) => p.id)).size).toBe(positions.length);
  });
});

describe('finalTally', () => {
  it('counts the claims the final judge upholds, and which reply it found better, from each round’s side', () => {
    const answers = [answer('h1', 'club', 'hint'), answer('l1', 'club', 'live')];
    const finals: FinalVerdict[] = [
      { pair: 'h1|club', keys: ['R2-001', 'R1-001'], falseClaims: { 'R1-001': ['x'], 'R2-001': [] }, givesAway: { 'R1-001': true, 'R2-001': false }, better: 'A', why: '' },
      { pair: 'l1|club', keys: ['R1-002', 'R2-002'], falseClaims: { 'R1-002': [], 'R2-002': ['y', 'z'] }, givesAway: null, better: 'tie', why: '' },
    ];
    expect(finalTally(answers, finals, ['R1-001', 'R1-002'])).toEqual({
      hint: { pairs: 1, falseClaims: 1, answersWithFalseClaim: 1, givesAway: 1, better: 0, worse: 1, tie: 0 },
      live: { pairs: 1, falseClaims: 0, answersWithFalseClaim: 0, givesAway: 0, better: 0, worse: 0, tie: 1 },
    });
    expect(finalTally(answers, finals, ['R2-001', 'R2-002']).live).toMatchObject({ falseClaims: 2, answersWithFalseClaim: 1 });
  });
});
