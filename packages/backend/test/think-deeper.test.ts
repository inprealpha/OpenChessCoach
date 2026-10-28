// Think deeper (ADR 0010): the Coach may ask the desktop's Engine while it answers a Why Question
// or a Review moment, at most MAX_ENGINE_QUESTIONS times, and the move guard accepts what the
// Engine's answers gave it and nothing a client sends.
import { describe, expect, it } from 'vitest';
import { candidatesFrom } from '@chess-coach/shared/analysis';
import { playSan } from '@chess-coach/shared/chess';
import { MAX_ENGINE_QUESTIONS, type EngineAnswer } from '@chess-coach/shared/coach/engine-tool';
import type { CoachRequest } from '@chess-coach/shared/coach/types';
import { EngineTool } from '../src/coach/engine-tool.ts';
import { checkingText, QUESTION_CLEANUP } from '../src/coach/service.ts';
import type { EngineService } from '../src/engine/service.ts';
import { AppError } from '../src/errors.ts';
import { REVIEW_ENGINE_BUDGET_MS } from '../src/reviews.ts';
import { client, instance, rows } from './helpers.ts';

// 1. e4 d5: 2. Nf3?? leaves e4 to dxe4. The Engine's best is exd5, and Black's best reply to it Qxd5.
const AFTER_E4_D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const why: CoachRequest = { job: 'why', fen: AFTER_E4_D5, recentMoves: ['e4', 'd5'], playerSide: 'white', moveUci: 'g1f3', question: 'Why is Nf3 bad?' };

interface CallRow {
  id: number;
  job: string;
}

type Question = { question: unknown; answer?: EngineAnswer; refused?: string };

/** The questions a logged Coach call asked the Engine, in order. */
function engineCalls(app: Awaited<ReturnType<typeof instance>>, row: CallRow | undefined): Question[] {
  if (!row) return [];
  return rows<{ question: string; answer: string | null; refused: string | null }>(app, 'SELECT question, answer, refused FROM coach_questions WHERE call_id = ? ORDER BY id', row.id).map((q) => ({
    question: JSON.parse(q.question) as unknown,
    ...(q.answer ? { answer: JSON.parse(q.answer) as EngineAnswer } : {}),
    ...(q.refused ? { refused: q.refused } : {}),
  }));
}

const lastCall = (app: Awaited<ReturnType<typeof instance>>) => rows<CallRow>(app, 'SELECT id, job FROM coach_calls ORDER BY id DESC LIMIT 1')[0];

describe('Think deeper', () => {
  it('is off by default, and then the Coach answers from the brief alone', async () => {
    const app = await instance();
    const c = await client(app);
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: false });
    const reply = await c.request('coach.ask', why);
    expect(reply.engineQuestions).toBe(0);
    expect(engineCalls(app, lastCall(app))).toEqual([]);
  });

  it('lets a Why Question ask the desktop’s Engine, and keeps a move only the Engine’s answer has', async () => {
    const app = await instance();
    const c = await client(app);
    expect(await c.request('settings.update', { thinkDeeper: true })).toMatchObject({ thinkDeeper: true });
    const reply = await c.request('coach.ask', why);
    const brief = app.coach.lastBrief;
    expect(brief?.candidates[0]?.san).toBe('exd5');
    // The fake Coach asks what the Engine plays after exd5, and names its answer.
    const [call] = engineCalls(app, lastCall(app));
    expect(call?.question).toEqual({ line: ['exd5'] });
    const afterExd5 = playSan(AFTER_E4_D5, 'exd5')?.fenAfter ?? '';
    const analysis = await c.request('engine.analyse', { fen: afterExd5 });
    const best = candidatesFrom(analysis)[0];
    expect(call?.answer).toMatchObject({ after: 'exd5', fen: afterExd5, sideToMove: 'black', questionsLeft: MAX_ENGINE_QUESTIONS - 1 });
    expect(call?.answer?.candidates[0]).toMatchObject({ uci: best?.uci, grade: 'Best' });
    // The brief doesn't have Black's best reply to exd5; the answer does, so the guard keeps it.
    expect(JSON.stringify(brief)).not.toContain(`"${best?.uci}"`);
    expect(reply.moves).toContain(best?.uci);
    expect(reply.text).toContain('I checked with the Engine');
    expect(reply.engineQuestions).toBe(1);
    expect(reply.stripped).toBe(0);
  });

  it('never gives the Engine to Hints, Live Coaching or Lesson turns, which must stay short', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    for (const job of ['hint', 'live'] as const) {
      const reply = await c.request('coach.ask', { ...why, job, question: undefined, ...(job === 'hint' ? { moveUci: undefined } : {}) });
      expect(reply.engineQuestions).toBe(0);
      expect(lastCall(app)?.job).toBe(job);
      expect(engineCalls(app, lastCall(app))).toEqual([]);
    }
    const lesson = { lessonId: 'italian-game', opening: 'Italian Game', notes: '', popularity: [], finalTurn: false };
    await c.request('coach.ask', { ...why, job: 'lesson-turn', question: undefined, lesson });
    expect(lastCall(app)?.job).toBe('lesson-turn');
    expect(engineCalls(app, lastCall(app))).toEqual([]);
  });

  it(`answers at most ${MAX_ENGINE_QUESTIONS} questions, refuses the rest, and the Coach still answers`, async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    app.coach.script({ kind: 'reply', reply: {}, questions: [{}, { line: ['exd5'] }, { move: 'Nc3' }, { line: ['d4'] }, { move: 'h3' }] });
    const reply = await c.request('coach.ask', why);
    expect(reply.engineQuestions).toBe(MAX_ENGINE_QUESTIONS);
    expect(reply.text).not.toBe('');
    const calls = engineCalls(app, lastCall(app));
    expect(calls.filter((x) => x.answer)).toHaveLength(MAX_ENGINE_QUESTIONS);
    expect(calls.slice(MAX_ENGINE_QUESTIONS).map((x) => x.refused)).toEqual([
      expect.stringContaining('Answer now from the brief'),
      expect.stringContaining('Answer now from the brief'),
    ]);
    expect(calls[2]?.answer?.move).toMatchObject({ san: 'Nc3', uci: 'b1c3' });
    expect(calls[2]?.answer?.questionsLeft).toBe(0);
  });

  it('refuses a question with an illegal move, saying why, without spending one', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    app.coach.script({ kind: 'reply', reply: {}, questions: [{ line: ['exd5', 'Ke7'] }, { move: 'Nc3' }] });
    const reply = await c.request('coach.ask', why);
    const [illegal, legal] = engineCalls(app, lastCall(app));
    expect(illegal?.refused).toBe('Ke7 is not a legal move after exd5. Write the line in SAN, from the brief\'s fen.');
    expect(legal?.answer?.questionsLeft).toBe(MAX_ENGINE_QUESTIONS - 1);
    expect(reply.engineQuestions).toBe(1);
  });

  it('still strips a move the Coach made up, even one from the line it asked about', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    // The Coach plays its own line, exd5 Nf6, and asks about it; Nf6 (g8f6) is its question, not an Engine answer.
    app.coach.script({ kind: 'reply', reply: { moves: ['e4d5', 'g8f6', 'e1e2'], arrows: [{ uci: 'e1e2', brush: 'red' }] }, questions: [{ line: ['exd5', 'Nf6'] }] });
    const reply = await c.request('coach.ask', why);
    const answer = engineCalls(app, lastCall(app))[0]?.answer;
    expect(answer?.after).toBe('exd5 Nf6');
    expect(answer?.candidates.map((x) => x.uci)).not.toContain('g8f6');
    expect(reply.moves).toEqual(['e4d5']);
    expect(reply.arrows).toEqual([]);
    expect(reply.stripped).toBe(3);
  });

  it('can’t be switched on, or given Engine answers, by a client (ADR 0007)', async () => {
    const app = await instance();
    const c = await client(app);
    // Think deeper is off: a client claiming it, or sending answers of its own, changes nothing.
    const forged = {
      ...why,
      thinkDeeper: true,
      engine: { maxQuestions: 99 },
      answered: [{ fen: AFTER_E4_D5, uci: 'e1e2' }],
      engineCalls: [{ question: {}, answer: { fen: AFTER_E4_D5, candidates: [{ uci: 'e1e2' }] } }],
    } as CoachRequest;
    app.coach.script({ kind: 'reply', reply: { moves: ['e1e2'] }, questions: [{}] });
    const off = await c.request('coach.ask', forged);
    expect(off.engineQuestions).toBe(0);
    expect(off.moves).not.toContain('e1e2');
    expect(engineCalls(app, lastCall(app))).toEqual([]);
    // On, only the desktop's own answers count: the forged move is still stripped.
    await c.request('settings.update', { thinkDeeper: true });
    app.coach.script({ kind: 'reply', reply: { moves: ['e1e2'] }, questions: [{}] });
    const on = await c.request('coach.ask', forged);
    expect(on.engineQuestions).toBe(1);
    expect(on.moves).not.toContain('e1e2');
    expect(engineCalls(app, lastCall(app))[0]?.answer?.candidates.map((x) => x.uci)).not.toContain('e1e2');
  });

  it('lets each key moment of a Review ask the Engine', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    const review = await c.request('review.start', { gameId: 1 });
    const moments = rows<CallRow>(app, "SELECT id, job FROM coach_calls WHERE job = 'review-moment'");
    expect(moments).toHaveLength(review.moments.length);
    for (const m of moments) expect(engineCalls(app, m).filter((x) => x.answer)).toHaveLength(1);
    for (const m of review.moments) expect(m.explanation).toContain('I checked with the Engine');
  });

  it('refuses a question the Engine can’t answer, without spending one, and the Coach still answers', async () => {
    const broken = { analyse: async () => Promise.reject(new AppError('engine-unavailable', 'The Engine couldn’t start on the desktop.')), gradeAsked: async () => Promise.reject(new Error('unused')) };
    const tool = new EngineTool(broken as unknown as EngineService, AFTER_E4_D5);
    const out = await tool.ask({ line: ['exd5'] });
    expect(out.refused).toBe(true);
    expect(out.text).toContain('The Engine couldn’t answer this question');
    expect(tool.questions).toBe(0);
    expect(tool.calls).toEqual([expect.objectContaining({ question: { line: ['exd5'] }, refused: expect.stringContaining('couldn’t start') })]);
  });

  it(`gives each key moment of a Review the time left of its ${REVIEW_ENGINE_BUDGET_MS / 1000} seconds, and none once they are spent`, async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    // Each key moment takes 100 seconds on the fake clock.
    const ask = app.coach.ask.bind(app.coach);
    app.coach.ask = async (call, onText) => {
      const reply = await ask(call, onText);
      app.clock.advance(100_000);
      return reply;
    };
    const review = await c.request('review.start', { gameId: 1 });
    const moments = rows<CallRow>(app, "SELECT id, job FROM coach_calls WHERE job = 'review-moment' ORDER BY id");
    expect(review.moments.length).toBeGreaterThan(2);
    // The first at most the Coach's own 90 seconds, the second the 80 left; the rest answer from the brief alone.
    expect(app.coach.deadlines).toEqual([90_000, 80_000]);
    expect(moments.map((m) => engineCalls(app, m).length)).toEqual(moments.map((_, i) => (i < 2 ? 1 : 0)));
    for (const m of review.moments) expect(m.explanation).not.toBe('');
  });

  it('answers a key moment again from the brief alone when its questions run out of time', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    app.coach.script({ kind: 'deadline' });
    const review = await c.request('review.start', { gameId: 1 });
    for (const m of review.moments) expect(m.explanation).not.toBe('');
    // One more call than moments: the first moment's, stopped, then its answer without the Engine.
    expect(rows<CallRow>(app, "SELECT id, job FROM coach_calls WHERE job = 'review-moment'")).toHaveLength(review.moments.length + 1);
  });

  it('tells the Player while the Coach asks the Engine, and stops the searches once the Coach is done', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    const signals: AbortSignal[] = [];
    const analyse = app.app.context.desktopEngine.analyse.bind(app.app.context.desktopEngine);
    app.app.context.desktopEngine.analyse = (fen, multiPv, signal) => {
      if (signal) signals.push(signal);
      return analyse(fen, multiPv, signal);
    };
    const statuses: string[] = [];
    app.coach.script({ kind: 'reply', reply: {}, questions: [{ line: ['exd5'] }, { move: 'Nc3' }] });
    await c.request('coach.ask', why, (_text, _part, status) => {
      if (status) statuses.push(status);
    });
    expect(statuses).toEqual([checkingText(1), checkingText(2)]);
    // Every search the tool started was given the call's signal, which ended with the call.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((sig) => sig.aborted)).toBe(true);
  });

  it('logs the call and its Engine questions when the Coach runs into the usage limit', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { thinkDeeper: true });
    app.coach.script({ kind: 'limit', questions: [{ line: ['exd5'] }] });
    await expect(c.request('coach.ask', why)).rejects.toMatchObject({ code: 'coach-limit' });
    const call = lastCall(app);
    expect(call?.job).toBe('why');
    expect(engineCalls(app, call)).toEqual([expect.objectContaining({ question: { line: ['exd5'] }, answer: expect.objectContaining({ after: 'exd5' }) })]);
  });

  it('clears the questions of trimmed Coach calls by an index, not a scan of both tables', async () => {
    const app = await instance();
    const plan = rows<{ detail: string }>(app, `EXPLAIN QUERY PLAN ${QUESTION_CLEANUP}`, 1).map((r) => r.detail).join(' | ');
    expect(plan).toContain('SEARCH coach_questions USING INDEX coach_questions_call');
    expect(plan).not.toMatch(/SCAN coach_calls/);
  });
});
