// "The only move that holds" and "any other move loses" in a Lesson note, against the Engine at
// verify mode's depth (issue #37), single-threaded so the same position always gets the same lines.
// The board checks of the notes (material, guards, the only legal move) are in
// packages/shared/test/note-claims.test.ts; this is the one kind of claim only the Engine can judge:
// the note's move holds, and every other legal move loses. "Loses" is the Lesson grades' own line:
// graded Mistake or Blunder against the note's move, on the Lichess formula (ADR 0002).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legalMoves, outcomeOf, playUci, uciToSan } from '@chess-coach/shared/chess';
import type { LessonData } from '@chess-coach/shared/content/lessons';
import type { Engine } from '@chess-coach/shared/engine';
import { gradeMove, isBadGrade } from '@chess-coach/shared/grader';
import { noteClaims, type HoldClaim } from '../../shared/test/note-claims.ts';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../../../data/lessons/${path}`, import.meta.url), 'utf8')) as T;
const lessons = read<{ id: string }[]>('index.json').map(({ id }) => read<LessonData>(`${id}.json`));
const holds = lessons.flatMap((l) => noteClaims(l).holds);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Why the claim is false at `depth`, or undefined when the note's move is the only one that doesn't lose. */
async function holdProblem(engine: Engine, claim: HoldClaim, depth: number): Promise<string | undefined> {
  const analysis = await engine.analyse(claim.fen, { multiPv: legalMoves(claim.fen).length, depth });
  const [top] = analysis.lines;
  const main = analysis.lines.find((l) => l.pv[0] === claim.uci);
  if (!top || !main) return `${claim.uci} is not among the Engine's lines`;
  const mates = (uci: string) => outcomeOf(playUci(claim.fen, uci)?.fenAfter as string)?.reason === 'checkmate';
  const own = gradeMove({ best: top.score, played: main.score, isTopMove: main === top, givesMate: mates(claim.uci) }).grade;
  if (isBadGrade(own)) return `the note's move is itself graded ${own}`;
  const alsoHold = analysis.lines.filter((l) => {
    const uci = l.pv[0] as string;
    return uci !== claim.uci && !isBadGrade(gradeMove({ best: main.score, played: l.score, isTopMove: false, givesMate: mates(uci) }).grade);
  });
  return alsoHold.length ? `${alsoHold.map((l) => uciToSan(claim.fen, l.pv[0] as string)).join(', ')} also hold` : undefined;
}

describe('"the only move that holds" in Lesson notes', () => {
  it('finds the claims', () => {
    expect(holds.map((h) => `${h.at}: ${h.phrase}`)).toEqual([
      'pawn-promotion part 3 hxg6: Any other move loses',
      'king-and-pawn part 3 Ke3: Any other move loses',
      'decoy part 1 Rxg7: any other move allows mate',
      'rook-endgames part 2 Rf8+: any other move here loses',
      'minor-piece-endgames part 3 Bd3: It is the only move that holds',
      'minor-piece-endgames part 4 Kd3: Any other move here loses',
      'minor-piece-endgames part 4 Kb1: 53.Kb1 is the only move that holds',
      'defending part 1 g3: It is the only good move',
    ]);
  });

  it.each(holds.map((h) => [h.at, h] as const))('%s: every other move loses', async (_at, claim) => {
    expect(await holdProblem(await createNodeEngine(1), claim, VERIFY_ENGINE.depth)).toBeUndefined();
  });

  it('fails on a note that calls a move the only one that holds when others hold too', async () => {
    // The starting position: 1.e4 is far from the only move that doesn't lose.
    const claim: HoldClaim = { at: 'golden', phrase: '1.e4 is the only move that holds', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', uci: 'e2e4' };
    expect(await holdProblem(await createNodeEngine(1), claim, VERIFY_ENGINE.depth)).toMatch(/also hold$/);
  });

  it('fails on "any other move loses" where other moves hold', async () => {
    const [claim] = noteClaims({
      id: 'golden',
      parts: [{ title: '', fen: START, side: 'white', keyIdea: '', credit: {}, mainLine: ['e2e4'], nodes: [{ ply: 0, fen: START, decision: true, main: 'e2e4', mainSan: 'e4', popular: {}, notes: { text: '1.e4 takes the centre. Any other move loses.' } }] }],
    } as unknown as LessonData).holds;
    expect(await holdProblem(await createNodeEngine(1), claim as HoldClaim, VERIFY_ENGINE.depth)).toMatch(/also hold$/);
  });

  it('fails on a real note whose move is not the one that holds', async () => {
    // Bd3 at minor-piece-endgames part 3, with the note moved onto a move that lets the pawn through.
    const real = holds.find((h) => h.at === 'minor-piece-endgames part 3 Bd3') as HoldClaim;
    const problem = await holdProblem(await createNodeEngine(1), { ...real, uci: 'g1f1' }, VERIFY_ENGINE.depth);
    expect(problem).toMatch(/^the note's move is itself graded (Mistake|Blunder)$/);
  });
});
