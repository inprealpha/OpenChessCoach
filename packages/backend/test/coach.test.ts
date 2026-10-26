// The Coach port through the protocol seam (ADR 0002, ADR 0004).
import { describe, expect, it } from 'vitest';
import type { CoachRequest } from '@chess-coach/shared/coach/types';
import { BRIEF_BUDGET } from '@chess-coach/shared/coach/brief';
import { candidatesFrom, gradeFromAnalyses } from '@chess-coach/shared/analysis';
import { playSan } from '@chess-coach/shared/chess';
import { scoreAfterPly } from '@chess-coach/shared/position-score';
import { winningChancesFor } from '@chess-coach/shared/winning-chances';
// The bar's own function on the Board and in Engine Games, so the test compares with the screen.
import { scoreFromAnalysis } from '../../web/src/lib/position-score.ts';
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

/** What the Winning Chances bar on the Board shows in a position, from the Engine at verify mode's settings, which the browser shares. */
async function barAt(fen: string, side: 'white' | 'black' = 'white'): Promise<string> {
  barEngine ??= createNodeEngine();
  const shown = scoreFromAnalysis(fen, await (await barEngine).analyse(fen, { depth: VERIFY_ENGINE.depth, multiPv: VERIFY_ENGINE.multiPv }));
  if (!shown) throw new Error('the Engine found no line');
  return winningChancesFor(shown.score, shown.pov, side).text;
}
let barEngine: ReturnType<typeof createNodeEngine> | undefined;

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

  it('quotes the Board’s Winning Chances bar either side of the move: the Engine’s best line in each position', async () => {
    const app = await instance();
    const c = await client(app);
    // A Why Question about 3. Bc4, as the Board sends it: the position, the move and no side.
    const before = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const bc4 = playSan(before, 'Bc4');
    if (!bc4) throw new Error('bad fixture');
    await c.request('coach.ask', { job: 'why', fen: before, recentMoves: ['e4', 'e5', 'Nf3', 'Nc6'], moveUci: bc4.uci });
    const [call] = rows<{ brief: string; raw_reply: string }>(app, 'SELECT brief, raw_reply FROM coach_calls');
    expect(JSON.parse(call?.brief ?? '{}').winningChances).toEqual({ before: await barAt(before), after: await barAt(bc4.fenAfter) });
    // The fake Coach repeats them, so journeys show what the real Coach is told.
    expect(JSON.parse(call?.raw_reply ?? '{}').text).toContain(`After it, ${await barAt(bc4.fenAfter)}.`);
  });

  it('quotes the bar’s Winning Chances and mate count after a move that was among the Engine’s lines', async () => {
    const app = await instance();
    const c = await client(app);
    // Board positions from the user-driven review (u6): before the fix the brief counted a mate from
    // the search before the move, one move or more longer than the bar.
    const cases = [
      { fen: 'r1bq3r/p1nppkbp/1p3ppn/2pP3P/4PP1N/8/PPP1B1P1/RNBQK2R w KQ - 5 10', san: 'd6', bar: 'White’s winning chances: 72%' },
      { fen: 'r1b2bR1/p2pk2p/1p3pP1/3QP3/2p1P1nN/8/PPP1B1P1/RNB1K2R w KQ - 1 17', san: 'Qd6+', bar: 'White mates in 1' },
      { fen: 'r1b2bR1/p2pk2p/1p3pP1/3QP3/2p1P1nN/8/PPP1B1P1/RNB1K2R w KQ - 1 17', san: 'exf6+', bar: 'White mates in 5' },
      // The Back-rank mate Lesson's third decision, set up on the Board, where the bar shows.
      { fen: 'r5k1/p4ppp/qp6/8/8/1P1R4/P1B2PPP/3R2K1 w - - 0 3', san: 'Rd8+', bar: 'White mates in 1' },
    ];
    for (const { fen, san } of cases) {
      const played = playSan(fen, san);
      if (!played) throw new Error(`${san} is not legal`);
      await c.request('coach.ask', { job: 'why', fen, recentMoves: [], moveUci: played.uci });
    }
    const said = rows<{ brief: string }>(app, 'SELECT brief FROM coach_calls ORDER BY id').map((r) => JSON.parse(r.brief).winningChances?.after);
    const shown = await Promise.all(cases.map(async ({ fen, san }) => barAt(playSan(fen, san)?.fenAfter ?? '')));
    expect(shown).toEqual(cases.map((x) => x.bar));
    expect(said).toEqual(shown);
  });

  it('leaves Winning Chances out where the screen hides the bar: Hints, Lesson turns, and Why Questions in a Lesson or a Puzzle', async () => {
    const app = await instance();
    const c = await client(app);
    const fen = 'r5k1/p4ppp/qp6/8/8/1P1R4/P1B2PPP/3R2K1 w - - 0 3';
    const rd8 = playSan(fen, 'Rd8+');
    if (!rd8) throw new Error('bad fixture');
    const lesson = { lessonId: 'back-rank-mate', opening: 'Back-rank mate', notes: '', popularity: [], finalTurn: false };
    await c.request('coach.ask', { job: 'hint', fen, recentMoves: [], playerSide: 'white' });
    await c.request('coach.ask', { job: 'lesson-turn', fen, recentMoves: [], playerSide: 'white', moveUci: rd8.uci, lesson });
    await c.request('coach.ask', { job: 'why', fen, recentMoves: [], playerSide: 'white', moveUci: rd8.uci, hideWinningChances: true });
    // The same Why Question on the Board, which shows the bar, still carries them.
    await c.request('coach.ask', { job: 'why', fen, recentMoves: [], playerSide: 'white', moveUci: rd8.uci });
    const briefs = rows<{ job: string; brief: string; raw_reply: string }>(app, 'SELECT job, brief, raw_reply FROM coach_calls ORDER BY id');
    expect(briefs.map((r) => [r.job, JSON.parse(r.brief).winningChances])).toEqual([
      ['hint', undefined],
      ['lesson-turn', undefined],
      ['why', undefined],
      ['why', { before: 'White mates in 2', after: 'White mates in 1' }],
    ]);
    for (const r of briefs.slice(0, 3)) expect(JSON.parse(r.raw_reply).text).not.toMatch(/winning chances|mates in/);
  });

  it('quotes the Review’s Winning Chances from its graded moves, in each key moment and in a Why Question asked from the Review', async () => {
    const app = await instance();
    const c = await client(app);
    const game = await c.request('games.get', { gameId: 1 });
    const review = await c.request('review.start', { gameId: 1 });
    // What the key-moment card and the bar show either side of the move (Review.svelte).
    const card = (ply: number) => {
      const [before, after] = [scoreAfterPly(review.moves, ply - 1), scoreAfterPly(review.moves, ply)];
      if (!before || !after) throw new Error(`no score around ply ${ply}`);
      return { before: winningChancesFor(before.score, before.pov, game.playerSide).text, after: winningChancesFor(after.score, after.pov, game.playerSide).text };
    };
    const briefs = (job: string) => rows<{ brief: string }>(app, 'SELECT brief FROM coach_calls WHERE job = ? ORDER BY id', job).map((r) => JSON.parse(r.brief).winningChances);
    expect(review.moments.length).toBeGreaterThan(0);
    expect(briefs('review-moment')).toEqual(review.moments.map((m) => card(m.ply)));
    // The Player selects each key moment's move, and two other moves the user-driven review (u6)
    // caught (3. Nf3: 52% against the bar's 53%; 10. a3: 53% against 51%), and asks why, as the
    // Review sends it.
    const plies = [...review.moments.map((m) => m.ply), 5, 19];
    expect([review.moves[4]?.san, review.moves[18]?.san]).toEqual(['Nf3', 'a3']);
    for (const ply of plies) {
      const move = review.moves[ply - 1];
      if (!move) throw new Error(`no graded move at ply ${ply}`);
      await c.request('coach.ask', {
        job: 'why',
        fen: move.fenBefore,
        recentMoves: review.moves.slice(0, ply - 1).map((x) => x.san),
        playerSide: game.playerSide,
        moveUci: move.uci,
        gameId: game.id,
      });
    }
    expect(briefs('why')).toEqual(plies.map(card));
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
      positionBefore: { score: { mate: 2 }, pov: 'white' },
      positionAfter: { score: { mate: 2 }, pov: 'white' },
      winningChances: { before: 'White’s winning chances: 99%' },
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
    expect(brief?.winningChances).toEqual({
      before: winningChancesFor(facts.move.candidates[0]?.score ?? { cp: 0 }, 'white').text,
      after: winningChancesFor(facts.replies[0]?.score ?? { cp: 0 }, 'black', 'white').text,
    });
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
