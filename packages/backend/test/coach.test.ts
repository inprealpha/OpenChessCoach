// The Coach port through the protocol seam (ADR 0002, ADR 0004).
import { describe, expect, it } from 'vitest';
import type { CoachRequest } from '@chess-coach/shared/coach/types';
import { BRIEF_BUDGET } from '@chess-coach/shared/coach/brief';
import { candidatesFrom, gradeFromAnalyses } from '@chess-coach/shared/analysis';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { NOTE_CAP } from '../src/profile.ts';
import { REPLY_SCHEMA } from '../src/coach/prompts.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';
import { toRawReply } from '../src/coach/real.ts';
import { client, instance, rows } from './helpers.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A Why Question about 1. e4, as a client sends it: the position and the move, no Engine facts. */
function whyAsk(): CoachRequest {
  return { job: 'why', fen: START, recentMoves: [], moveUci: 'e2e4', question: 'Why e4?' };
}

/** The desktop Engine's own facts for 1. e4, from Node Stockfish at the verify depth. */
async function engineFacts() {
  const engine = await createNodeEngine();
  const { depth, multiPv } = VERIFY_ENGINE;
  const before = await engine.analyse(START, { depth, multiPv });
  const after = await engine.analyse('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { depth, multiPv });
  return { move: gradeFromAnalyses(1, 'e2e4', before, after), replies: candidatesFrom(after) };
}

describe('the Coach port', () => {
  it('streams the reply and strips a move the Engine never suggested before it reaches the client', async () => {
    const app = await instance();
    const c = await client(app);
    app.coach.script({ kind: 'reply', reply: { text: 'Push the h-pawn.', moves: ['h2h4', 'e2e4'], arrows: [{ uci: 'h2h4', brush: 'red' }] } });
    const deltas: string[] = [];
    const reply = await c.request('coach.ask', whyAsk(), (t) => deltas.push(t));
    expect(deltas.join('')).toBe('Push the h-pawn.');
    expect(reply.moves).toEqual(['e2e4']);
    expect(reply.arrows).toEqual([]);
    expect(reply.stripped).toBe(2);
    // Without the guard the move would have gone through: the Coach really sent it.
    const [call] = rows<{ raw_reply: string; stripped: string }>(app, 'SELECT raw_reply, stripped FROM coach_calls');
    expect(JSON.parse(call?.raw_reply ?? '{}').moves).toContain('h2h4');
    expect(JSON.parse(call?.stripped ?? '[]')).toHaveLength(2);
  });

  it('records the brief the backend sent, within budget, with only the matching profile slice', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('profile.update', { goals: ['Learn the Italian Game', 'Play the London System'] });
    const ask = { ...(whyAsk()), opening: 'Italian Game' };
    await c.request('coach.ask', ask);
    const [call] = rows<{ brief: string; job: string; model: string; coach: string }>(app, 'SELECT * FROM coach_calls');
    expect(call).toMatchObject({ job: 'why', model: 'sonnet', coach: 'fake' });
    expect(call?.brief.length).toBeLessThanOrEqual(BRIEF_BUDGET);
    const brief = JSON.parse(call?.brief ?? '{}');
    expect(brief).toMatchObject({ job: 'why', level: 'casual', fen: START, question: 'Why e4?', move: { san: 'e4' } });
    expect(brief.profile.goals).toEqual(['Learn the Italian Game']);
    expect(brief).not.toHaveProperty('evaluation');
    expect(app.coach.lastBrief).toEqual(brief);
  });

  it('sends each job to the model chosen for it in Settings', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { models: { live: 'opus', why: 'haiku' } as never });
    const ask = whyAsk();
    await c.request('coach.ask', ask);
    await c.request('coach.ask', { ...ask, job: 'live' });
    await c.request('coach.ask', { ...ask, job: 'hint' });
    expect(rows<{ job: string; model: string }>(app, 'SELECT job, model FROM coach_calls ORDER BY id')).toEqual([
      { job: 'why', model: 'haiku' },
      { job: 'live', model: 'opus' },
      { job: 'hint', model: 'haiku' },
    ]);
    expect(app.coach.models).toEqual(['haiku', 'opus', 'haiku']);
    await expect(c.request('settings.update', { models: { why: 'sonnet; rm -rf /' } as never })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('keeps Coach notes short, de-duplicated and capped', async () => {
    const app = await instance();
    const c = await client(app);
    // Notes are only allowed on a Lesson's last turn or a Review's last key moment.
    const lesson = { lessonId: 'italian-game', opening: 'Italian Game', notes: '', popularity: [], finalTurn: true };
    const ask: CoachRequest = { ...whyAsk(), job: 'lesson-turn', lesson };
    for (let i = 0; i < NOTE_CAP + 3; i++) {
      app.coach.script({ kind: 'reply', reply: { note: `Note number ${i}` } });
      await c.request('coach.ask', ask);
    }
    app.coach.script({ kind: 'reply', reply: { note: 'note NUMBER 14!' } });
    expect((await c.request('coach.ask', ask)).note).toBeNull();
    const notes = rows<{ text: string }>(app, 'SELECT text FROM coach_notes ORDER BY id');
    expect(notes).toHaveLength(NOTE_CAP);
    expect(notes[0]?.text).toBe('Note number 3');
    // A note is only kept when the call allowed one.
    app.coach.script({ kind: 'reply', reply: { note: 'Not allowed here' } });
    expect((await c.request('coach.ask', { ...ask, lesson: { ...lesson, finalTurn: false } })).note).toBeNull();
  });

  it('reports a usage limit and an unavailable Coach in plain language', async () => {
    const app = await instance();
    const c = await client(app);
    const ask = whyAsk();
    app.coach.script({ kind: 'limit' });
    await expect(c.request('coach.ask', ask)).rejects.toMatchObject({ code: 'coach-limit' });
    expect(c.events.some((e) => e.kind === 'coach-status' && e.status.state === 'limit-reached')).toBe(true);
    await expect(c.request('coach.ask', ask)).rejects.toMatchObject({ code: 'coach-limit' });
    app.clock.advance(2 * 3_600_000);
    app.coach.script({ kind: 'unavailable' });
    await expect(c.request('coach.ask', ask)).rejects.toMatchObject({ code: 'coach-unavailable', message: expect.stringContaining('not logged in') });
  });

  it('builds the brief from the desktop Engine’s facts and ignores any a client sends (ADR 0007)', async () => {
    const app = await instance();
    const c = await client(app);
    const forged = {
      ...whyAsk(),
      move: { uci: 'e2e4', san: 'e4', grade: 'Blunder', playedScore: { cp: -900 } },
      candidates: [{ uci: 'h2h4', san: 'h4', score: { cp: 500 }, pv: ['h2h4'] }],
      replies: [{ uci: 'a7a5', san: 'a5', score: { cp: 0 }, pv: ['a7a5'] }],
      allowNote: true,
    } as CoachRequest;
    app.coach.script({ kind: 'reply', reply: { text: 'h4 is best.', moves: ['h2h4'], note: 'Forged note' } });
    const reply = await c.request('coach.ask', forged);
    const facts = await engineFacts();
    const brief = app.coach.lastBrief;
    expect(brief?.move).toMatchObject({ uci: 'e2e4', grade: facts.move.grade });
    const briefCandidates = brief?.candidates.map((x) => x.uci) ?? [];
    const briefReplies = brief?.replies?.map((x) => x.uci) ?? [];
    expect(briefCandidates.length).toBeGreaterThan(1);
    expect(briefCandidates).toEqual(facts.move.candidates.map((x) => x.uci).slice(0, briefCandidates.length));
    expect(briefReplies).toEqual(facts.replies.map((x) => x.uci).slice(0, briefReplies.length));
    expect(brief?.candidates.map((x) => x.uci)).not.toContain('h2h4');
    // The guard checks the Coach against the desktop's facts, so the forged move is stripped.
    expect(reply.moves).toEqual([]);
    expect(reply.note).toBeNull();
  });

  it('grades a move on the desktop’s Engine for clients without one', async () => {
    const app = await instance();
    const c = await client(app);
    const graded = await c.request('engine.grade', { fen: START, uci: 'e2e4' });
    const facts = await engineFacts();
    expect(graded.move.grade).toBe(facts.move.grade);
    expect(graded.replies.map((x) => x.uci)).toEqual(facts.replies.map((x) => x.uci));
    const analysis = await c.request('engine.analyse', { fen: START });
    expect(analysis.lines.map((l) => l.pv[0])).toEqual(facts.move.candidates.map((x) => x.uci));
    await expect(c.request('engine.grade', { fen: START, uci: 'e2e5' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('treats an empty reply as a Coach error, not a silent answer', async () => {
    const app = await instance();
    const c = await client(app);
    app.coach.script({ kind: 'reply', reply: { text: '  ' } });
    await expect(c.request('coach.ask', whyAsk())).rejects.toMatchObject({ code: 'coach-error', message: expect.stringContaining('empty') });
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(1);
  });

  it('reads the real Coach\'s explanation from its structured output when nothing was streamed', () => {
    const structured = { text: 'e4 takes the centre.', moves: ['e2e4'], arrows: [], highlights: [], note: null };
    expect(toRawReply('', structured).text).toBe('e4 takes the centre.');
    expect(toRawReply('Streamed text. ', { ...structured, text: '' }).text).toBe('Streamed text.');
    expect(toRawReply('', undefined).text).toBe('');
    expect(REPLY_SCHEMA.required).toContain('text');
  });

  it('refuses an illegal position or move before calling the Coach', async () => {
    const app = await instance();
    const c = await client(app);
    await expect(c.request('coach.ask', { job: 'why', fen: 'not a fen', recentMoves: [] })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.request('coach.ask', { ...whyAsk(), moveUci: 'e2e5' })).rejects.toMatchObject({ code: 'bad-request', message: expect.stringContaining('not a legal move') });
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(0);
  });

  it('refuses a Why Question over the length limit before calling the Coach', async () => {
    const app = await instance();
    const c = await client(app);
    await expect(c.request('coach.ask', { ...whyAsk(), question: 'Why? '.repeat(1000) })).rejects.toMatchObject({
      code: 'bad-request',
      message: 'A question can be at most 300 characters.',
    });
    await expect(c.request('coach.ask', { ...whyAsk(), question: 3 as never })).rejects.toMatchObject({ code: 'bad-request' });
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(0);
    // At the limit it goes through whole: the brief keeps every character of it (ADR 0004).
    const longest = `Why e4 ${'and not d4 '.repeat(40)}`.slice(0, 300);
    await c.request('coach.ask', { ...whyAsk(), question: longest });
    const [call] = rows<{ brief: string }>(app, 'SELECT brief FROM coach_calls');
    expect(call?.brief).toContain(longest.trim());
  });

  it('refuses a malformed Lesson context before calling the Coach', async () => {
    const app = await instance();
    const c = await client(app);
    const lesson = { lessonId: 'italian-game', opening: 'Italian Game', notes: '', popularity: [{ san: 'e4', percent: 60 }], finalTurn: false };
    const ask: CoachRequest = { ...whyAsk(), job: 'lesson-turn', lesson };
    const { popularity: _missing, ...noPopularity } = lesson;
    for (const bad of [noPopularity, { ...lesson, popularity: [{ san: 'e4' }] }, { ...lesson, notes: 3 }, 'Italian Game']) {
      await expect(c.request('coach.ask', { ...ask, lesson: bad as never })).rejects.toMatchObject({ code: 'bad-request' });
    }
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(0);
    await expect(c.request('coach.ask', ask)).resolves.toMatchObject({ stripped: expect.any(Number) });
  });
});
