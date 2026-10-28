// The Engine as the Coach's tool (ADR 0010): its answers say what a brief says, and the move
// guard accepts what they gave the Coach and nothing it made up. Each rule is proven against a
// deliberately broken input, on real games graded by Stockfish (the golden fixtures).
import { describe, expect, it } from 'vitest';
import type { Candidate, GradedMove } from '../src/analysis.ts';
import { buildBrief, type Brief } from '../src/coach/brief.ts';
import {
  answerMoves,
  engineAnswer,
  MAX_QUESTION_PLIES,
  placeQuestion,
  QuestionError,
  type EngineAnswer,
} from '../src/coach/engine-tool.ts';
import { guardReply } from '../src/coach/guard.ts';
import type { CoachRawReply } from '../src/coach/types.ts';
import { game } from './golden.ts';

const profile = { level: 'casual' as const, rating: null, goals: [], weaknesses: [], notes: [] };
const g = game('fzjtms6a');

/** A move of the golden game and the Engine's lines after it, as the desktop's Engine grades them. */
function moment(at: number): { m: GradedMove; replies: Candidate[]; asked: Candidate } {
  const m = g.moves[at];
  const replies = g.moves[at + 1]?.candidates;
  if (!m || !replies?.length) throw new Error('fixture too short');
  // As the desktop grades a move a Why Question names: scored by the search after it, with the Engine's line there.
  const asked = { uci: m.uci, san: m.san, score: m.playedScore, pv: [m.uci, ...(replies[0]?.pv ?? [])] };
  return { m, replies, asked };
}

/** The first move of the golden game the Engine didn't list as a candidate. */
function unlistedAt(): number {
  const at = g.moves.findIndex((m, i) => i > 4 && !m.candidates.some((c) => c.uci === m.uci) && g.moves[i + 1]?.candidates.length);
  if (at < 0) throw new Error('no unlisted move in the fixture');
  return at;
}

describe('the Engine tool’s answers', () => {
  it('grade and explain a position’s best moves exactly as the brief does', () => {
    const { m } = moment(12);
    const brief = buildBrief({ ask: { job: 'why', fen: m.fenBefore, recentMoves: [], candidates: m.candidates }, profile });
    const answer = engineAnswer(placeQuestion(m.fenBefore, {}), m.candidates, undefined, 2);
    expect(answer.candidates.length).toBe(3);
    expect(answer.candidates).toEqual(brief.candidates.slice(0, 3));
    expect(answer).toMatchObject({ after: 'the brief’s position', fen: m.fenBefore, questionsLeft: 2 });
  });

  it('grade and explain a move the Engine didn’t list exactly as the brief grades a move the Player asks about', () => {
    const { m, replies, asked } = moment(unlistedAt());
    const brief = buildBrief({ ask: { job: 'why', fen: m.fenBefore, recentMoves: [], candidates: m.candidates, asked: [asked] }, profile });
    const inBrief = brief.candidates.find((c) => c.asked);
    const answer = engineAnswer(placeQuestion(m.fenBefore, { move: m.san }), m.candidates, { move: asked, replies }, 0);
    const { replies: answerReplies, ...move } = answer.move ?? { replies: [] };
    expect(inBrief).toBeDefined();
    expect({ ...move, asked: true }).toEqual(inBrief);
    // Its replies are the Engine's best replies to it, said as the brief says the replies to the move.
    expect(answerReplies.map((r) => r.uci)).toEqual(replies.slice(0, 2).map((r) => r.uci));
  });

  it('answer about the position after a line of moves, played from the brief’s position', () => {
    const { m } = moment(12);
    const next = g.moves[13];
    const after = g.moves[14];
    if (!next || !after) throw new Error('fixture too short');
    const placed = placeQuestion(m.fenBefore, { line: [m.san, next.san] });
    expect(placed).toEqual({ line: [m.san, next.san], fen: after.fenBefore, last: { fen: next.fenBefore, uci: next.uci, san: next.san } });
    const answer = engineAnswer(placed, after.candidates, undefined, 1);
    expect(answer).toMatchObject({ after: `${m.san} ${next.san}`, sideToMove: after.side });
    expect(answer.candidates[0]?.uci).toBe(after.candidates[0]?.uci);
  });

  it('say what the last move of the line does, exactly as the brief says what the Player’s move does', () => {
    // A move of a real game with facts on it: the brief's move, and the same move as the end of a line.
    const at = g.moves.findIndex((m, i) => {
      const replies = g.moves[i + 1]?.candidates;
      if (!replies?.length) return false;
      const b = buildBrief({ ask: { job: 'why', fen: m.fenBefore, recentMoves: [], candidates: m.candidates, move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore }, replies }, profile });
      return Boolean(b.move?.does);
    });
    const { m, replies } = moment(at);
    const brief = buildBrief({ ask: { job: 'why', fen: m.fenBefore, recentMoves: [], candidates: m.candidates, move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore }, replies }, profile });
    const answer = engineAnswer(placeQuestion(m.fenBefore, { line: [m.san] }), replies, undefined, 2);
    expect(brief.move?.does).toBeTruthy();
    expect(answer.lastMove).toMatchObject({ san: m.san, does: brief.move?.does });
    // Without a line there is no last move to describe.
    expect(engineAnswer(placeQuestion(m.fenBefore, {}), m.candidates, undefined, 2).lastMove).toBeUndefined();
  });

  it('say when the game is over in the position, with no moves', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#.
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const placed = placeQuestion(start, { line: ['f3', 'e5', 'g4', 'Qh4#'] });
    expect(engineAnswer(placed, [], undefined, 0)).toMatchObject({ over: 'Black has given mate', candidates: [] });
    expect(() => placeQuestion(start, { line: ['f3', 'e5', 'g4', 'Qh4#'], move: 'Kf2' })).toThrow(QuestionError);
  });

  it('refuse a line or a move that isn’t legal, saying where, and a line that is too long', () => {
    const { m } = moment(12);
    expect(() => placeQuestion(m.fenBefore, { line: ['Ke8'] })).toThrow(/Ke8 is not a legal move in the brief’s position/);
    expect(() => placeQuestion(m.fenBefore, { line: [m.san], move: m.san })).toThrow(new RegExp(`${m.san.replace('+', '\\+')} is not a legal move after ${m.san.replace('+', '\\+')}`));
    expect(() => placeQuestion(m.fenBefore, { line: Array(MAX_QUESTION_PLIES + 1).fill(m.san) as string[] })).toThrow(/at most/);
    expect(() => placeQuestion(m.fenBefore, { line: 'e4' as unknown as string[] })).toThrow(QuestionError);
  });
});

describe('the move guard with the Engine tool’s answers', () => {
  const at = unlistedAt();
  const { m, replies, asked } = moment(at);
  const next = g.moves[at + 1];
  const deep = g.moves[at + 2];
  if (!next || !deep?.candidates.length) throw new Error('fixture too short');
  const brief: Brief = buildBrief({
    ask: { job: 'why', fen: m.fenBefore, recentMoves: [], candidates: m.candidates, move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore }, replies },
    profile,
  });
  const reply = (r: Partial<CoachRawReply>): CoachRawReply => ({ text: 'x', moves: [], arrows: [], highlights: [], note: null, ...r });
  // The Coach asks about the position two moves into the game's line, and about the move in the brief's own position.
  const deepAnswer: EngineAnswer = engineAnswer(placeQuestion(m.fenBefore, { line: [m.san, next.san] }), deep.candidates, undefined, 2);
  const rootAnswer = engineAnswer(placeQuestion(m.fenBefore, { move: asked.san }), m.candidates, { move: asked, replies }, 1);
  // A move only the deep answer has: the Engine's best move there, which the brief can't contain.
  const deepBest = deep.candidates.map((c) => c.uci).find((uci) => !brief.candidates.some((c) => c.uci === uci) && !brief.replies?.some((r) => r.uci === uci)) ?? '';

  it('keeps a move only the Engine’s answer has, and draws it only in the position on the board', () => {
    expect(deepBest).not.toBe('');
    expect(guardReply(brief, reply({ moves: [deepBest] })).moves).toEqual([]);
    const out = guardReply(brief, reply({ moves: [deepBest], arrows: [{ uci: deepBest, brush: 'blue' }] }), answerMoves(deepAnswer));
    expect(out.moves).toEqual([deepBest]);
    // Deeper in a line, the board doesn't show the position it is played in.
    expect(out.arrows).toEqual([]);
    // The move asked about in the brief's own position may be drawn.
    const drawn = guardReply(brief, reply({ arrows: [{ uci: asked.uci, brush: 'red' }] }), answerMoves(rootAnswer));
    expect(drawn.arrows).toEqual([{ from: asked.uci.slice(0, 2), to: asked.uci.slice(2, 4), brush: 'red' }]);
  });

  it('still strips a move the Coach made up, even one it played in its own question’s line', () => {
    // The Coach's line is its question, not the Engine's answer: its second move isn't in the answer.
    const answered = answerMoves(deepAnswer);
    expect(answered.some((a) => a.uci === next.uci && a.fen === next.fenBefore)).toBe(false);
    const madeUp = 'a1a8';
    const out = guardReply(brief, reply({ moves: [madeUp, next.uci], arrows: [{ uci: madeUp, brush: 'red' }] }), answered);
    expect(out.moves).not.toContain(madeUp);
    expect(out.arrows).toEqual([]);
    expect(out.stripped).toContain(`move ${madeUp} is not in the Engine's output`);
    expect(out.stripped).toContain(`arrow ${madeUp} is not in the Engine's output`);
  });

  it('accepts nothing from an answer whose move isn’t legal where it says it is played', () => {
    expect(guardReply(brief, reply({ moves: ['a1a8'] }), [{ fen: m.fenBefore, uci: 'a1a8' }]).moves).toEqual([]);
  });

  it('shows no move at all in a Hint, whatever an answer holds', () => {
    const hint = { ...brief, hideMoves: true };
    expect(guardReply(hint, reply({ moves: [asked.uci] }), answerMoves(rootAnswer)).moves).toEqual([]);
  });
});
