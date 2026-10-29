// The real-Coach check's structural rules, each proven against a deliberately broken reply.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { CoachRawReply, CoachReply } from '@chess-coach/shared/coach/types';
import type { EngineAnswer } from '@chess-coach/shared/coach/engine-tool';
import { avoidedTerms } from '../glossary-lint.ts';
import { CHECK_MODEL, type CallVerdict, checkCall, RecordingCoach, ROLE_BREAK_TERMS, summarize } from '../real-coach-check.ts';
import type { CoachCall, CoachPort } from '../../packages/backend/src/coach/port.ts';

const AFTER_E4_D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const brief: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: AFTER_E4_D5,
  recentMoves: '1. e4 d5',
  move: { san: 'Nf3', uci: 'g1f3', grade: 'Blunder', evaluationAfter: '-1.2' },
  candidates: [
    { san: 'exd5', uci: 'e4d5', evaluation: '+0.40', grade: 'Best', line: 'Qxd5 Nc3' },
    { san: 'Nc3', uci: 'b1c3', evaluation: '+0.10', grade: 'Inaccuracy', line: 'dxe4 Nxe4' },
  ],
  replies: [{ san: 'dxe4', uci: 'd5e4', evaluation: '+1.20', grade: 'Best', line: 'Ng5' }],
  maxWords: 40,
  allowNote: false,
  hideMoves: false,
};
const raw: CoachRawReply = { text: '', moves: ['e4d5'], arrows: [], highlights: [], note: null };
const good: CoachReply = {
  text: 'Nf3 leaves the e4 pawn hanging, so dxe4 wins it. Take back first with exd5 and keep the pawn.',
  moves: ['e4d5'],
  arrows: [{ from: 'e4', to: 'd5', brush: 'green' }],
  highlights: [],
  note: null,
  stripped: 0,
  model: 'sonnet',
  engineQuestions: 0,
};
const terms = ['accuracy', 'tutor', 'computer'];
const check = (reply: Partial<CoachReply>, b: Partial<Brief> = {}) => checkCall({ job: 'why', brief: { ...brief, ...b }, raw }, { ...good, ...reply }, terms);

describe('the real-Coach check', () => {
  it('passes a reply whose moves and text all come from the brief', () => {
    expect(check({}).problems).toEqual([]);
  });

  it('fails a move that is not legal, or that the Engine never suggested', () => {
    expect(check({ moves: ['e2e5'] }).problems).toEqual(['the reply shows e2e5, which is not legal here']);
    expect(check({ arrows: [{ from: 'a2', to: 'a4', brush: 'green' }] }).problems).toEqual(['the reply shows a2a4, which the Engine never suggested']);
  });

  it('accepts the threat’s move where the guard does: after a pass, in a question about the position', () => {
    const position: Partial<Brief> = { move: undefined, replies: undefined, threat: { by: 'black', san: 'dxe4', uci: 'd5e4', line: 'd4 Nf6' } };
    const shows: Partial<CoachReply> = { text: 'Black threatens dxe4.', moves: ['d5e4'], arrows: [{ from: 'd5', to: 'e4', brush: 'red' }] };
    expect(check(shows, position).problems).toEqual([]);
    // After 2. exd5 the pawn is gone, so a reply that still shows dxe4 fails.
    const exd5: Partial<Brief> = { ...position, move: { san: 'exd5', uci: 'e4d5', grade: 'Best', evaluationAfter: '+0.60' } };
    expect(check(shows, exd5).problems).toEqual(['the reply shows d5e4, which is not legal here', 'the reply shows d5e4, which is not legal here']);
  });

  it('fails a piece move named in the text that is not in the brief', () => {
    expect(check({ text: 'Bb5+ was the move.' }).problems).toEqual(['the text names Bb5, which is not in the brief']);
  });

  it('fails a Hint that names a move', () => {
    expect(check({ text: 'Think about exd5.', moves: [], arrows: [] }, { job: 'hint', hideMoves: true }).problems).toEqual(['the Hint names the move exd5']);
  });

  it('warns just over the length budget and fails well over it', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    expect(check({ text: words(45) })).toMatchObject({ problems: [], warnings: ['45 words, over the 40-word budget'] });
    expect(check({ text: words(60) }).problems).toEqual(['60 words, over the 40-word budget by more than 25%']);
  });

  it('warns on a term CONTEXT.md says to avoid, and still fails a move the Engine never suggested beside it', () => {
    expect(check({ text: 'The computer likes exd5.' })).toMatchObject({ problems: [], warnings: ['the text uses "computer", which CONTEXT.md says to avoid'] });
    expect(check({ text: 'Your accuracy drops after exd5.', arrows: [{ from: 'a2', to: 'a4', brush: 'green' }] })).toMatchObject({
      problems: ['the reply shows a2a4, which the Engine never suggested'],
      warnings: ['the text uses "accuracy", which CONTEXT.md says to avoid'],
    });
  });

  it('fails a reply where the Coach breaks role, and still only warns on the other avoided terms in it', () => {
    const contextTerms = avoidedTerms(readFileSync(new URL('../../CONTEXT.md', import.meta.url), 'utf8'));
    expect(contextTerms).toEqual(expect.arrayContaining([...ROLE_BREAK_TERMS]));
    const refusal = 'As an AI assistant, I am not able to judge chess positions. Please ask a human tutor or use a computer.';
    expect(checkCall({ job: 'why', brief, raw }, { ...good, text: refusal }, contextTerms)).toMatchObject({
      problems: ['the text uses "assistant", so the Coach broke role', 'the text uses "ai", so the Coach broke role'],
      warnings: ['the text uses "computer", which CONTEXT.md says to avoid', 'the text uses "tutor", which CONTEXT.md says to avoid'],
    });
    expect(checkCall({ job: 'why', brief, raw }, { ...good, text: 'The user should take back with exd5.' }, contextTerms).problems).toEqual(['the text uses "user", so the Coach broke role']);
  });

  it('accepts moves and names from the Engine’s answers with Think deeper on, drawn only on the board’s position', () => {
    // The Coach asked what Black plays after exd5: Qxd5, which the brief doesn't have.
    const answer: EngineAnswer = {
      after: 'exd5',
      fen: 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      sideToMove: 'black',
      candidates: [{ san: 'Qxd5', uci: 'd8d5', evaluation: '-0.30', grade: 'Best', line: 'Nc3 Qa5' }],
      questionsLeft: 2,
    };
    const text = 'After exd5, the Engine answers Qxd5, taking the pawn back.';
    const record = (answers?: EngineAnswer[]) => ({ job: 'why' as const, brief, raw: { ...raw, moves: ['d8d5'] }, ...(answers ? { answers } : {}) });
    // Without the answer, Qxd5 is no move the reply may show.
    expect(checkCall(record(), { ...good, text, moves: ['d8d5'] }, terms).problems).toEqual(['the reply shows d8d5, which is not legal here']);
    expect(checkCall(record([answer]), { ...good, text, moves: ['d8d5'] }, terms).problems).toEqual([]);
    // Deeper than the board, an answer's move is named, not drawn.
    expect(checkCall(record([answer]), { ...good, text, moves: [], arrows: [{ from: 'd8', to: 'd5', brush: 'yellow' }] }, terms).problems).toEqual([
      'the reply shows d8d5, which is not legal here',
    ]);
  });

  it('fails a reply that gives away the Lesson’s move the brief keeps back, in its text, moves or arrows', () => {
    // 2. Nf3 was not the Lesson's move, 2. exd5 was: the brief keeps exd5 back.
    const keptBack: Partial<Brief> = { job: 'lesson-turn', candidates: [], lesson: { opening: 'Scandinavian', notes: '', popularity: '', isLessonMove: false } };
    const hidden = [{ uci: 'e4d5', san: 'exd5' }];
    const reply = (r: Partial<CoachReply>) => checkCall({ job: 'lesson-turn', brief: { ...brief, ...keptBack }, raw }, { ...good, moves: [], arrows: [], ...r }, terms, hidden);
    expect(reply({ text: 'Nf3 leaves the e4 pawn hanging: dxe4 takes it. Try another move.', moves: ['d5e4'] }).problems).toEqual([]);
    const gives = 'the reply gives away exd5, which the brief keeps back';
    expect(reply({ text: 'Nf3 leaves the pawn hanging.', arrows: [{ from: 'e4', to: 'd5', brush: 'green' }] }).problems).toContain(gives);
    expect(reply({ text: 'Nf3 leaves the pawn hanging.', moves: ['e4d5'] }).problems).toContain(gives);
    expect(reply({ text: 'Take back first with exd5.' }).problems).toEqual(['the text names exd5, which is not in the brief', gives]);
  });

  it('passes a run whose calls only have warnings, and counts them in the posted status', () => {
    const call = (warnings: string[], problems: string[] = []): CallVerdict => ({ job: 'why', words: 30, maxWords: 150, problems, warnings });
    expect(summarize([call([]), call([])])).toEqual({ ok: true, description: '2 Coach calls passed the structural checks' });
    expect(summarize([call(['the text uses "score", which CONTEXT.md says to avoid']), call([]), call(['45 words, over the 40-word budget'])])).toEqual({
      ok: true,
      description: '3 Coach calls passed the structural checks, 2 warnings: the text uses "score", which CONTEXT.md says to avoid',
    });
    expect(summarize([call(['45 words, over the 40-word budget'])]).description).toBe('1 Coach call passed the structural checks, 1 warning: 45 words, over the 40-word budget');
    const failed = summarize([call(['45 words, over the 40-word budget']), call([], ['the reply is empty'])]);
    expect(failed).toEqual({ ok: false, description: '1 of 2 Coach calls failed: the reply is empty' });
    // GitHub refuses a status description over 140 characters.
    expect(summarize([call([`the text uses "${'x'.repeat(200)}"`])]).description.length).toBeLessThanOrEqual(140);
  });

  it('runs every call on the latest Haiku, whatever model the job uses in the app', async () => {
    const models: string[] = [];
    const inner: CoachPort = {
      name: 'fake',
      status: async () => ({ state: 'ready' }),
      ask: async (call: CoachCall) => {
        models.push(call.model);
        return raw;
      },
    };
    const coach = new RecordingCoach(inner);
    await coach.ask({ job: 'why', model: 'sonnet', brief }, () => {});
    await coach.ask({ job: 'hint', model: 'haiku', brief }, () => {});
    expect(CHECK_MODEL).toBe('haiku');
    expect(models).toEqual(['haiku', 'haiku']);
    expect(coach.calls.map((c) => c.job)).toEqual(['why', 'hint']);
  });

  it('keeps the Engine’s answers in a call with Think deeper on', async () => {
    const answer = { after: 'the brief’s position', fen: AFTER_E4_D5, sideToMove: 'white', candidates: [], questionsLeft: 2 };
    const inner: CoachPort = {
      name: 'fake',
      status: async () => ({ state: 'ready' }),
      ask: async (call: CoachCall) => {
        await call.engine?.ask({});
        await call.engine?.ask({ line: ['Ke7'] });
        return raw;
      },
    };
    const engine = { maxQuestions: 3, maxCalls: 5, exhausted: false, ask: async (q: { line?: string[] }) => (q.line ? { text: 'Ke7 is not legal', refused: true } : { text: JSON.stringify(answer), refused: false }) };
    const coach = new RecordingCoach(inner);
    await coach.ask({ job: 'why', model: 'sonnet', brief, engine }, () => {});
    await coach.ask({ job: 'why', model: 'sonnet', brief }, () => {});
    expect(coach.calls.map((c) => c.answers)).toEqual([[answer], undefined]);
  });
});
