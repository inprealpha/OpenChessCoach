// The deep Lesson check (#28): a stricter pass over the moves a Lesson asks for, run only in
// data-prep and only on the moves a change adds, so it costs nothing in the app or at runtime.
//
// The Engine check (engine-check.ts, ADR 0008) grades each move at depths 10 and 14, the depths the
// app grades at. That is enough to catch a move that loses material, but not one that is only a
// little worse than the best move: in a quiet position the gap between Good and an Inaccuracy is
// about half a pawn, and a shallow search's score moves by that much from one depth to the next.
// The chess review found a move in Open files that passed at 10 and 14 and was an Inaccuracy deeper
// down. This check searches deeper, and fails a move that is graded Good but sits close to an
// Inaccuracy, since one more ply could tip it over.
//
// In endgames with 7 pieces or fewer the Engine is the wrong judge: it scores a slower win as worse
// than a faster one, and the 300-centipawn floor (ADR 0002) can call a move that keeps the win a
// Mistake. There the tablebase decides: a move passes when it keeps the best result the position
// has (a win stays a win, a draw stays a draw), however long it takes.
import { gradeFromAnalyses } from '@chess-coach/shared/analysis';
import { outcomeOf, piecesOf, playUci, sanLine } from '@chess-coach/shared/chess';
import { decisions, type Decision, type LessonData } from '@chess-coach/shared/content/lessons';
import type { Engine, EngineLine } from '@chess-coach/shared/engine';
import { formatScore, GRADE_THRESHOLDS } from '@chess-coach/shared/grader';

/** The deep pass's depth: the app's deepest is 14. */
export const DEEP_DEPTH = 22;

/**
 * A move graded Good that gives up this much winning chance or more fails: it is too close to an
 * Inaccuracy (0.1) for a deeper search to be sure of it.
 */
export const HEADROOM = 0.08;

/** The tablebase covers positions with this many pieces or fewer, kings included, and no castling. */
export const TABLEBASE_PIECES = 7;

/** A result in the Lichess tablebase, from the side to move's point of view. */
export type TablebaseCategory =
  | 'win'
  | 'syzygy-win'
  | 'maybe-win'
  | 'cursed-win'
  | 'draw'
  | 'blessed-loss'
  | 'maybe-loss'
  | 'syzygy-loss'
  | 'loss'
  | 'unknown';

/** The tablebase's answer for a position: its result, and each legal move's result for the opponent. */
export interface TablebaseAnswer {
  category: TablebaseCategory;
  moves: { uci: string; category: TablebaseCategory }[];
}

export type Tablebase = (fen: string) => Promise<TablebaseAnswer>;

/**
 * What a result is worth to the side to move, for comparing moves: a win, a draw or a loss. A cursed
 * win or blessed loss is a draw under the 50-move rule, so it counts as one. A maybe-win is a win
 * that might be cursed, so it sits between. Undefined when the tablebase doesn't know.
 */
function worth(category: TablebaseCategory): number | undefined {
  switch (category) {
    case 'win':
    case 'syzygy-win':
      return 2;
    case 'maybe-win':
      return 1;
    case 'cursed-win':
    case 'draw':
    case 'blessed-loss':
      return 0;
    case 'maybe-loss':
      return -1;
    case 'syzygy-loss':
    case 'loss':
      return -2;
    default:
      return undefined;
  }
}

const RESULT_NAMES: Record<number, string> = { 2: 'a win', 1: 'a win (perhaps not within 50 moves)', 0: 'a draw', [-1]: 'a loss (perhaps not within 50 moves)', [-2]: 'a loss' };

/** Whether the tablebase can judge a position: few enough pieces and no castling left. */
export function inTablebase(fen: string): boolean {
  return piecesOf(fen).length <= TABLEBASE_PIECES && fen.split(' ')[2] === '-';
}

/**
 * The tablebase's verdict on a move: undefined when it passes, the reason when it doesn't, or
 * 'unknown' when the tablebase can't say and the Engine has to judge.
 */
export function tablebaseVerdict(answer: TablebaseAnswer, uci: string): string | undefined | 'unknown' {
  // Each move's category is the opponent's result after it, so the mover's is its opposite.
  const forMover = answer.moves.map((m) => ({ uci: m.uci, worth: worth(m.category) }));
  if (!forMover.length || forMover.some((m) => m.worth === undefined)) return 'unknown';
  const best = Math.max(...forMover.map((m) => -(m.worth as number)));
  const played = forMover.find((m) => m.uci === uci);
  if (!played) return 'unknown';
  const result = -(played.worth as number);
  return result === best ? undefined : `turns ${RESULT_NAMES[best]} into ${RESULT_NAMES[result]} (tablebase)`;
}

/** The Lichess tablebase (tablebase.lichess.ovh), one request at a time, with answers kept for the run. */
export function lichessTablebase(fetchImpl: typeof fetch = fetch, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Tablebase {
  const cache = new Map<string, Promise<TablebaseAnswer>>();
  let queue: Promise<unknown> = Promise.resolve();
  const ask = async (fen: string): Promise<TablebaseAnswer> => {
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      try {
        const res = await fetchImpl(`https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`, { headers: { accept: 'application/json' } });
        status = res.status;
        if (res.ok) {
          const body = (await res.json()) as TablebaseAnswer;
          return { category: body.category, moves: body.moves.map((m) => ({ uci: m.uci, category: m.category })) };
        }
      } catch {
        // a network error: try again
      }
      if (attempt >= 5) throw new Error(`The Lichess tablebase didn't answer for ${fen}${status ? ` (HTTP ${status})` : ''}`);
      // Lichess asks clients that get a 429 to wait a minute.
      await wait(status === 429 ? 60_000 : 2_000 * 2 ** (attempt - 1));
    }
  };
  return (fen) => {
    let answer = cache.get(fen);
    if (!answer) {
      answer = queue.then(() => ask(fen));
      queue = answer.catch(() => undefined);
      cache.set(fen, answer);
    }
    return answer;
  };
}

/** The key of a decision: its position and the move it asks for. Anything else about it doesn't change the grade. */
const keyOf = (d: Decision) => `${d.node.fen}|${d.node.main}`;

/**
 * The decisions in `lesson` that `before` (the same Lesson at an earlier commit) didn't have: all of
 * them for a new Lesson. A change to a note or a key idea adds none.
 */
export function newDecisions(lesson: LessonData, before: LessonData | undefined): Decision[] {
  const had = new Set(before ? decisions(before).map(keyOf) : []);
  return decisions(lesson).filter((d) => !had.has(keyOf(d)));
}

/**
 * The deep check on some of a Lesson's decisions: the tablebase where it can judge, the Engine at
 * `depth` with the headroom elsewhere. Returns one line per move that fails.
 */
export async function deepCheck(engine: Engine, tablebase: Tablebase, lesson: LessonData, list: readonly Decision[], depth = DEEP_DEPTH): Promise<string[]> {
  const failures: string[] = [];
  for (const { partIndex, node } of list) {
    const where = `${lesson.id} part ${partIndex + 1} ${node.mainSan}`;
    if (inTablebase(node.fen)) {
      const verdict = tablebaseVerdict(await tablebase(node.fen), node.main);
      if (verdict === undefined) continue;
      if (verdict !== 'unknown') {
        failures.push(`${where}: ${verdict}`);
        continue;
      }
    }
    const options = { multiPv: 1, depth };
    const before = await engine.analyse(node.fen, options);
    const top = before.lines[0];
    if (top?.pv[0] === node.main) continue;
    const after = playUci(node.fen, node.main)?.fenAfter as string;
    const next = outcomeOf(after) ? undefined : await engine.analyse(after, options);
    const { grade, winLoss } = gradeFromAnalyses(node.ply + 1, node.main, before, next);
    const tooClose = grade === 'Good' && winLoss >= HEADROOM;
    if (grade !== 'Best' && grade !== 'Good') failures.push(`${where} at depth ${depth}: ${grade}, ${describe(node.fen, winLoss, top)}`);
    else if (tooClose) failures.push(`${where} at depth ${depth}: Good, but too close to an Inaccuracy (${GRADE_THRESHOLDS.Inaccuracy}), ${describe(node.fen, winLoss, top)}`);
  }
  return failures;
}

function describe(fen: string, winLoss: number, top: EngineLine | undefined): string {
  const engineMove = top ? `${sanLine(fen, top.pv.slice(0, 1))[0]} ${formatScore(top.score)}` : 'none';
  return `gives up ${winLoss.toFixed(3)} of winning chance (Engine: ${engineMove})`;
}
