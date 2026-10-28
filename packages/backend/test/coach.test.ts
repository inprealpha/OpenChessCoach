// The Coach port through the protocol seam (ADR 0002, ADR 0004).
import { describe, expect, it } from 'vitest';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import type { CoachRequest } from '@chess-coach/shared/coach/types';
import { BRIEF_BUDGET, type Brief } from '@chess-coach/shared/coach/brief';
import { candidatesFrom, gradeFromAnalyses } from '@chess-coach/shared/analysis';
import { playSan } from '@chess-coach/shared/chess';
import { formatScore } from '@chess-coach/shared/grader';
import { scoreAfterPly } from '@chess-coach/shared/position-score';
import { winningChancesFor } from '@chess-coach/shared/winning-chances';
// The bar's own function on the Board and in Engine Games, so the test compares with the screen.
import { scoreFromAnalysis } from '../../web/src/lib/position-score.ts';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { NOTE_CAP } from '../src/profile.ts';
import { REPLY_SCHEMA, SYSTEM_PROMPT } from '../src/coach/prompts.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';
import { RealCoach, toRawReply } from '../src/coach/real.ts';
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
      threat: { side: 'black', uci: 'e7e5', san: 'e5', pv: ['e7e5'], score: { cp: 900 }, winLoss: 0.5 },
      asked: [{ uci: 'h2h4', san: 'h4', score: { cp: 500 }, pv: ['h2h4'] }],
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
    // The start position holds no threat for the desktop's Engine, whatever the client claims.
    expect(brief).not.toHaveProperty('threat');
    // The guard checks the Coach against the desktop's facts, so the forged move is stripped.
    expect(reply.moves).toEqual([]);
    expect(reply.note).toBeNull();
  });

  it('tells the Coach the opponent’s threat from the desktop’s Engine, and none in a quiet position or in check', async () => {
    const app = await instance();
    const c = await client(app);
    // 1. e4 d5: Black threatens dxe4.
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const { threat } = await c.request('engine.threat', { fen });
    expect(threat).toMatchObject({ side: 'black', uci: 'd5e4', san: 'dxe4' });
    // A Why Question about the position: the threat as the Engine found it after a pass.
    const position = await c.request('coach.ask', { job: 'why', fen, recentMoves: ['e4', 'd5'], playerSide: 'white' });
    expect(app.coach.lastBrief?.threat).toEqual({ by: 'black', san: 'dxe4', uci: 'd5e4', line: expect.any(String) });
    // The fake Coach names it, so journeys show what the real Coach is told.
    expect(position.text).toContain('Watch out: Black threatens dxe4.');
    // 2. Nf3 does nothing about it: the Engine's best reply is still dxe4, and the brief says so.
    const nf3 = await c.request('coach.ask', { job: 'why', fen, recentMoves: ['e4', 'd5'], playerSide: 'white', moveUci: 'g1f3' });
    expect(app.coach.lastBrief?.replies?.[0]?.uci).toBe('d5e4');
    expect(app.coach.lastBrief?.threat).toMatchObject({ by: 'black', san: 'dxe4', uci: 'd5e4', ignored: true });
    expect(nf3.text).toContain('Nf3 leaves Black\'s threat dxe4 on.');
    expect(nf3.moves).toContain('d5e4');

    // A quiet position: the start position's best "threat" is a free tempo, not a threat.
    await c.request('coach.ask', whyAsk());
    expect(app.coach.lastBrief).not.toHaveProperty('threat');
    // In check there is no threat to speak of: the side to move must answer the check.
    const check = 'rnbqkbnr/ppppp1pp/8/5p1Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2';
    await c.request('coach.ask', { job: 'why', fen: check, recentMoves: ['e4', 'f5', 'Qh5+'] });
    expect(app.coach.lastBrief).not.toHaveProperty('threat');
  });

  it('tells the Coach what the key moves do, and in Live Coaching only those', async () => {
    const app = await instance();
    const c = await client(app);
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5: Black's best reply Qg5 attacks the knight and the g2 pawn at once.
    const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const ask = { fen, recentMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'], playerSide: 'white' as const, moveUci: 'f3e5' };
    await c.request('coach.ask', { job: 'why', ...ask });
    const why = app.coach.lastBrief;
    expect(why?.move?.does).toContain("takes Black's pawn on e5");
    expect(why?.candidates.slice(1).some((x) => x.does)).toBe(true);
    // Live Coaching must stay short: facts only on the move, the best move and the best reply.
    await c.request('coach.ask', { job: 'live', ...ask });
    const live = app.coach.lastBrief;
    expect(live?.move?.does).toContain("takes Black's pawn on e5");
    expect(live?.candidates.slice(1).every((x) => !x.does && !x.result)).toBe(true);
    expect(live?.replies?.slice(1).every((x) => !x.does)).toBe(true);
  });

  it('grades and explains a move the Player’s Why Question names when the Engine didn’t list it, and lets the Coach show it', async () => {
    const app = await instance();
    const c = await client(app);
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4: the Player castled and asks about 4. Nxe5, which the Engine doesn't list.
    const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const ask = { job: 'why' as const, fen, recentMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'], playerSide: 'white' as const, moveUci: 'e1g1' };
    const graded = await c.request('engine.grade', { fen, uci: 'f3e5' });
    const asked = {
      san: 'Nxe5',
      uci: 'f3e5',
      evaluation: formatScore(graded.move.playedScore),
      grade: graded.move.grade,
      line: expect.stringMatching(new RegExp(`^${graded.replies[0]?.san.replace('+', '\\+')} `)),
      does: expect.stringContaining("takes Black's pawn on e5"),
      asked: true,
    };
    const reply = await c.request('coach.ask', { ...ask, question: 'Why not Nxe5?' });
    const brief = app.coach.lastBrief;
    expect(brief?.move?.san).toBe('O-O');
    expect(brief?.candidates).toHaveLength(6);
    expect(brief?.candidates.slice(0, 5).every((x) => x.uci !== 'f3e5' && !x.asked)).toBe(true);
    expect(brief?.candidates[5]).toEqual(expect.objectContaining(asked));
    // The guard lets the Coach show it: the move now comes from the Engine.
    expect(reply.text).toContain(`You asked about Nxe5: it is graded ${graded.move.grade}. It takes Black's pawn on e5`);
    expect(reply.moves).toContain('f3e5');
    expect(reply.arrows).toContainEqual({ from: 'f3', to: 'e5', brush: 'blue' });
    expect(reply.stripped).toBe(0);
    // The Coach can name the Engine's reply to it as well, but draws only the move itself.
    const lineMove = graded.replies[0]?.uci as string;
    app.coach.script({ kind: 'reply', reply: { text: 'Nxe5 runs into a strong reply.', moves: ['f3e5', lineMove], arrows: [{ uci: 'f3e5', brush: 'blue' }, { uci: lineMove, brush: 'red' }] } });
    const shown = await c.request('coach.ask', { ...ask, question: '   Why not Nxe5?   ' });
    expect(shown).toMatchObject({ moves: ['f3e5', lineMove], arrows: [{ from: 'f3', to: 'e5', brush: 'blue' }], stripped: 1 });
    expect(app.coach.lastBrief?.question).toBe('Why not Nxe5?');
    // Asked about the position, with the move named among others in a sentence.
    await c.request('coach.ask', { ...ask, moveUci: undefined, question: 'I wanted to play Nxe5!? here, why is it bad?' });
    expect(app.coach.lastBrief?.candidates.find((x) => x.asked)).toEqual(expect.objectContaining(asked));
  });

  it('marks a named move the Engine already listed, and changes nothing for a move that isn’t legal or isn’t named', async () => {
    const app = await instance();
    const c = await client(app);
    const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const ask = { job: 'why' as const, fen, recentMoves: [], playerSide: 'white' as const, moveUci: 'e1g1' };
    const briefFor = async (question: string, job: 'why' | 'lesson-turn' = 'why') => {
      const lesson = { lessonId: 'italian-game', opening: 'Italian Game', notes: '', popularity: [], finalTurn: false };
      await c.request('coach.ask', { ...ask, job, question, ...(job === 'lesson-turn' ? { lesson } : {}) });
      if (!app.coach.lastBrief) throw new Error('no Coach call');
      const { question: _q, ...brief } = app.coach.lastBrief;
      return brief;
    };
    const plain = await briefFor('Why?');
    // c3 is one of the Engine's candidates: it is marked, and the brief gains no candidate.
    const c3 = await briefFor('Why not c3?');
    expect(c3.candidates.map((x) => x.uci)).toEqual(plain.candidates.map((x) => x.uci));
    expect(c3.candidates.filter((x) => x.asked).map((x) => x.san)).toEqual(['c3']);
    // A queen move that isn't legal, a pawn push onto a pawn, the move itself and a move in words.
    for (const question of ['Why not Qxf7?', 'Why is e5 weak?', 'Why O-O?', 'Why not take the pawn on e5?']) {
      expect(await briefFor(question)).toEqual(plain);
    }
    // A square named for a piece is not a pawn push, though d3 is legal; "Why not d3?" is one.
    expect(await briefFor('Why can’t my bishop go to d3?')).toEqual(plain);
    expect((await briefFor('Why not d3?')).candidates.filter((x) => x.asked).map((x) => x.uci)).toEqual(['d2d3']);
    // Asked about the Engine's best move, the fake Coach draws it in green and the next option in blue.
    const [top, next] = plain.candidates;
    const reply = await c.request('coach.ask', { ...ask, moveUci: undefined, question: `Why not ${top?.san}?` });
    expect(reply.arrows).toEqual(expect.arrayContaining([
      { from: top?.uci.slice(0, 2), to: top?.uci.slice(2, 4), brush: 'green' },
      { from: next?.uci.slice(0, 2), to: next?.uci.slice(2, 4), brush: 'blue' },
    ]));
    // Only a Why Question pays for the extra search: a Lesson turn's typed reasoning names no move for the Engine.
    expect((await briefFor('I played it because Nxe5 loses a piece', 'lesson-turn')).candidates.some((x) => x.asked || x.uci === 'f3e5')).toBe(false);
  });

  it('leaves out a named move either side could mean, unless the move asked about is the Player’s own', async () => {
    const app = await instance();
    const c = await client(app);
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4, asked about Black's 3... Bc5: Black's knight could go to d4 instead, and White's can go there next.
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
    const askedFor = async (question: string, playerSide?: 'white' | 'black') => {
      await c.request('coach.ask', { job: 'why', fen, recentMoves: [], moveUci: 'f8c5', question, ...(playerSide ? { playerSide } : {}) });
      return app.coach.lastBrief?.candidates.filter((x) => x.asked).map((x) => x.san);
    };
    // White's Player, or one the Board doesn't name, may mean White's Nd4 next: it is left out.
    expect(await askedFor('Why not Nd4?', 'white')).toEqual([]);
    expect(await askedFor('Why not Nd4?')).toEqual([]);
    // Black's Player asks about their own other option; only Black can play Nf6.
    expect(await askedFor('Why not Nd4?', 'black')).toEqual(['Nd4']);
    expect(await askedFor('Why not Nf6?', 'white')).toEqual(['Nf6']);
  });

  it('drops the threat once the move dealt with it, so the Coach neither names it nor shows it', async () => {
    const app = await instance();
    const c = await client(app);
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    // 2. exd5 takes the pawn that threatened, and 2. Nc3 defends e4: the Engine's best reply is no longer dxe4.
    for (const moveUci of ['e4d5', 'b1c3']) {
      const reply = await c.request('coach.ask', { job: 'why', fen, recentMoves: ['e4', 'd5'], playerSide: 'white', moveUci });
      expect(app.coach.lastBrief?.replies?.[0]?.uci).not.toBe('d5e4');
      expect(app.coach.lastBrief).not.toHaveProperty('threat');
      expect(reply.text).not.toMatch(/threat/);
      expect(reply.moves).not.toContain('d5e4');
    }
    // A Coach that names it anyway after exd5, where it isn't legal, has it stripped: no red arrow
    // from White's own pawn on d5 back to e4.
    app.coach.script({ kind: 'reply', reply: { text: 'Black threatens dxe4.', moves: ['d5e4'], arrows: [{ uci: 'd5e4', brush: 'red' }] } });
    const forced = await c.request('coach.ask', { job: 'why', fen, recentMoves: ['e4', 'd5'], playerSide: 'white', moveUci: 'e4d5' });
    expect(forced).toMatchObject({ moves: [], arrows: [], stripped: 2 });

    // Live Coaching after 1. g4 d5 2. f3: f3 defends g4, and the Engine's best reply is no longer Bxg4.
    const g4 = 'rnbqkbnr/ppp1pppp/8/3p4/6P1/8/PPPPPP1P/RNBQKBNR w KQkq - 0 2';
    expect((await c.request('engine.threat', { fen: g4 })).threat).toMatchObject({ san: 'Bxg4' });
    const live = await c.request('coach.ask', { job: 'live', fen: g4, recentMoves: ['g4', 'd5'], playerSide: 'white', moveUci: 'f2f3' });
    expect(app.coach.lastBrief?.replies?.[0]?.uci).not.toBe('c8g4');
    expect(app.coach.lastBrief).not.toHaveProperty('threat');
    expect(live.text).not.toMatch(/Bxg4|threat/);
  });

  it('never tells the Coach a threat after a move that ends the game: Rxd8# in the Back-rank mate Lesson', async () => {
    const app = await instance();
    const c = await client(app);
    // Decision 4: Black's rook on d8 threatens Rxd1+, and Rxd8# takes it with mate.
    const fen = '3r2k1/p4ppp/qp6/8/8/1P6/P1B2PPP/3R2K1 w - - 0 4';
    expect((await c.request('engine.threat', { fen })).threat).toMatchObject({ san: 'Rxd1+' });
    const lesson = { lessonId: 'back-rank-mate', opening: 'Back-rank mate', notes: '', popularity: [], finalTurn: false };
    const reply = await c.request('coach.ask', { job: 'lesson-turn', fen, recentMoves: [], playerSide: 'white', moveUci: 'd1d8', lesson });
    expect(app.coach.lastBrief?.move?.san).toBe('Rxd8#');
    expect(app.coach.lastBrief).not.toHaveProperty('threat');
    expect(reply.text).not.toMatch(/Rxd1|threat/);
    expect(reply.moves).not.toContain('d8d1');
  });

  it('names the threat by the side that makes it, when the Player asks about the opponent’s move', async () => {
    const app = await instance();
    const c = await client(app);
    // 1. e4 e5 2. Qh5 Nc6 3. Bc4: White, the Player, threatens Qxf7#, and Black's 3... Nf6 leaves it on.
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    const reply = await c.request('coach.ask', { job: 'why', fen, recentMoves: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4'], playerSide: 'white', moveUci: 'g8f6' });
    expect(app.coach.lastBrief).toMatchObject({ playerSide: 'white', threat: { by: 'white', san: 'Qxf7#', ignored: true } });
    expect(reply.text).toContain('Nf6 leaves White\'s threat Qxf7# on.');
    // The prompt words the threat by threat.by, never as "the opponent's", and leaves the judgement to the Engine (ADR 0002).
    const rule = SYSTEM_PROMPT.split('\n- ').find((r) => r.startsWith('When the brief has threat')) ?? '';
    expect(rule).toContain('threat.by');
    expect(rule).toContain('threat.ignored');
    expect(rule).not.toMatch(/opponent|does nothing about/);
  });

  it('keeps a Coach move that names the threat, and still strips a move the Engine never produced', async () => {
    const app = await instance();
    const c = await client(app);
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    app.coach.script({
      kind: 'reply',
      reply: { text: 'Black threatens dxe4.', moves: ['d5e4', 'h2h3'], arrows: [{ uci: 'd5e4', brush: 'red' }, { uci: 'h2h3', brush: 'blue' }] },
    });
    const reply = await c.request('coach.ask', { job: 'why', fen, recentMoves: ['e4', 'd5'] });
    expect(reply.moves).toEqual(['d5e4']);
    expect(reply.arrows).toEqual([{ from: 'd5', to: 'e4', brush: 'red' }]);
    expect(reply.stripped).toBe(2);
  });

  it('tells the Coach the threat in a key moment of a Review only when the move left it on, as the desktop’s Engine finds it', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('review.start', { gameId: 1 });
    const briefs = app.coach.briefs.filter((b) => b.job === 'review-moment');
    expect(briefs.length).toBeGreaterThan(0);
    for (const b of briefs) {
      const { threat } = await c.request('engine.threat', { fen: b.fen });
      if (threat && b.replies?.[0]?.uci === threat.uci) expect(b.threat).toMatchObject({ by: threat.side, uci: threat.uci, ignored: true });
      else expect(b).not.toHaveProperty('threat');
    }
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

  it('keeps the claude.ai account\'s connectors out of real Coach calls', async () => {
    let sent: Options | undefined;
    const fakeQuery = (({ options }: { options?: Options }) => {
      sent = options;
      return (async function* () {})();
    }) as unknown as typeof query;
    const brief: Brief = { job: 'why', level: 'casual', sideToMove: 'white', fen: START, recentMoves: '', candidates: [], maxWords: 120, allowNote: false, hideMoves: false };
    await new RealCoach({ query: fakeQuery }).ask({ job: 'why', model: 'haiku', brief }, () => {});
    expect(sent?.mcpServers).toEqual({});
    expect(sent?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    // The env option replaces Claude Code's whole environment, so the rest must come along.
    expect(sent?.env?.PATH).toBe(process.env.PATH);
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
