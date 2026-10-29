// ADR 0012: after a move that isn't the Lesson's, the Player may try again, so the brief keeps the
// Lesson's move back. This walks every decision of every Lesson, plays other moves (the Engine's best
// one that isn't the Lesson's, and moves the Engine doesn't list, which are often poor), builds the
// brief as the desktop does for that turn, and looks for the Lesson's move anywhere in it: by its
// name, and in the words that describe it without one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidatesFrom } from '@chess-coach/shared/analysis';
import { legalMoves, playUci } from '@chess-coach/shared/chess';
import { buildBrief, type Brief } from '@chess-coach/shared/coach/brief';
import { decisions, type LessonData } from '@chess-coach/shared/content/lessons';
import type { MoveGrade } from '@chess-coach/shared/grader';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { EngineService } from '../src/engine/service.ts';

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../../../data/lessons/${path}`, import.meta.url), 'utf8')) as T;
const lessons = read<{ id: string }[]>('index.json').map(({ id }) => read<LessonData>(`${id}.json`));
// A low depth keeps the walk quick; the replies and the lines still run several moves on.
const engine = new EngineService(() => createNodeEngine(1), { depth: 6, multiPv: 5 });
const profile = { level: 'beginner' as const, rating: null, goals: [], weaknesses: [], notes: [] };

/**
 * The brief's text where the Lesson's move would give it away. Left out: the position and the moves
 * that led to it, which are the past; the learning goal, which the screen shows before the Lesson
 * starts (an opening's names its moves); and the opponent's moves, the replies and the threat, where
 * the same name is another side's move.
 */
function answerable(brief: Brief): string {
  const { fen: _fen, recentMoves: _recent, focus, replies, threat, ...rest } = brief;
  return JSON.stringify({
    ...rest,
    ...(focus ? { focus: { ...focus, learningGoal: '' } } : {}),
    ...(replies ? { replies: replies.map((r) => ({ ...r, san: '' })) } : {}),
    ...(threat ? { threat: { ...threat, san: '' } } : {}),
  });
}

/**
 * Whether `text` names the move `san` (in UCI `uci`), with or without its check or mate sign. A
 * pawn move's name is its square, which the facts name for the pieces on it ("the knight on d4"):
 * that is a square, not the move.
 */
function names(text: string, san: string, uci: string): boolean {
  const bare = san.replace(/[+#]$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.includes(uci) || new RegExp(`(?<![\\w-]|\\bon )${bare}(?![\\w-])`).test(text);
}

/**
 * The words that describe the Lesson's move without naming it. After a reply, what the line's next
 * move does ("where White's queen can take it", "the square White's rook goes to next") is the
 * Player's next move; at the end of a mate, the square the mate lands on and what boxes the king in
 * can be the Lesson's mate.
 */
const NEXT_MOVE_WORDS = /can take it|goes to next/;
const MATE_WORDS = /at the end|giving mate on/;

/** The Lesson's move found anywhere in the briefs after other moves, and the Move Grades of those moves. */
interface Walk {
  leaks: string[];
  grades: MoveGrade[];
}

async function walk(lesson: LessonData): Promise<Walk> {
  const leaks: string[] = [];
  const grades: MoveGrade[] = [];
  for (const { part, node } of decisions(lesson)) {
    const listed = candidatesFrom(await engine.analyse(node.fen)).map((c) => c.uci);
    const unlisted = legalMoves(node.fen).filter((uci) => uci !== node.main && !listed.includes(uci));
    const others = [listed.find((uci) => uci !== node.main), unlisted[0], unlisted.at(-1)].filter((uci, i, all): uci is string => uci !== undefined && all.indexOf(uci) === i);
    for (const uci of others) {
      const ask = await engine.factsFor({
        job: 'lesson-turn',
        fen: node.fen,
        recentMoves: part.nodes.slice(0, node.ply).map((n) => n.mainSan),
        playerSide: part.side,
        moveUci: uci,
        lesson: { lessonId: lesson.id, opening: lesson.name, notes: node.notes?.text ?? '', popularity: node.popular.beginner, finalTurn: false, isLessonMove: false },
        lessonFocus: { lesson: lesson.name, learningGoal: lesson.goal, keyIdea: part.keyIdea },
      });
      grades.push(ask.move?.grade ?? 'Best');
      const brief = buildBrief({ ask, profile });
      const after = playUci(node.fen, uci)?.san;
      // The key idea is kept back too: it can all but name the Lesson's move.
      if (brief.focus?.keyIdea !== undefined) leaks.push(`the key idea after ${after}`);
      if (names(answerable(brief), node.mainSan, node.main)) leaks.push(`${node.mainSan} after ${after}: ${answerable(brief)}`);
      for (const r of brief.replies ?? []) if (r.does && NEXT_MOVE_WORDS.test(r.does)) leaks.push(`the move after ${after} ${r.san}: ${r.does}`);
      if (brief.move?.result && MATE_WORDS.test(brief.move.result)) leaks.push(`where the mate after ${after} ends: ${brief.move.result}`);
    }
  }
  return { leaks, grades };
}

const walks = new Map<string, Promise<Walk>>();
/** A Lesson's walk, run once, by whichever test needs it first. */
function walked(lesson: LessonData): Promise<Walk> {
  if (!walks.has(lesson.id)) walks.set(lesson.id, walk(lesson));
  return walks.get(lesson.id)!;
}

describe('a Lesson turn that keeps the answer back', () => {
  it.each(lessons.map((l) => [l.id, l] as const))('never names the Lesson’s move in %s', async (_id, lesson) => {
    expect((await walked(lesson)).leaks).toEqual([]);
  });

  it('was tried with poor moves too', async () => {
    const grades: MoveGrade[] = [];
    for (const lesson of lessons) grades.push(...(await walked(lesson)).grades);
    expect(grades.filter((g) => g === 'Mistake' || g === 'Blunder').length).toBeGreaterThan(grades.length / 4);
  });
});
