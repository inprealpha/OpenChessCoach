// A Review's Winning Chances graph: one point per position of the game, from White's point
// of view as on Lichess, drawn from the graded moves the Review already carries, so it needs no
// Engine run (ADR 0007). Winning Chances keep every point between 0 and 100, so a mate or a huge
// evaluation never flattens the rest of the graph. Mistakes and Blunders, by either side, are marked.
import type { GradedMove } from './analysis.ts';
import { moveLabel, moveNumberOf, SIDE_NAMES, type Side } from './chess.ts';
import type { MoveGrade } from './grader.ts';
import { scoreAfterPly } from './position-score.ts';
import { winningChancesFor } from './winning-chances.ts';

/** The Move Grades the graph marks. */
export type MarkedGrade = Extract<MoveGrade, 'Mistake' | 'Blunder'>;

export interface GraphMark {
  grade: MarkedGrade;
  /** The side that made the move. */
  side: Side;
  /** The point's accessible name: "Mistake by White, move 11". */
  name: string;
}

export interface GraphPoint {
  /** 0 for the start position, otherwise the ply of the move that led here. */
  ply: number;
  /** White's Winning Chances, 0 to 100. */
  percent: number;
  /** What a hover or tap reads: "11. Bxf7+: White’s winning chances: 35%", or "Start: …". */
  label: string;
  mark?: GraphMark;
}

function isMarked(grade: MoveGrade): grade is MarkedGrade {
  return grade === 'Mistake' || grade === 'Blunder';
}

/**
 * The graph's points: the start position, then the position after each graded move, each scored
 * as the Winning Chances bar and the key moments score it (`scoreAfterPly`).
 */
export function winningChancesGraph(moves: readonly GradedMove[]): GraphPoint[] {
  const chancesAt = (ply: number) => {
    const s = scoreAfterPly(moves, ply);
    return s ? winningChancesFor(s.score, s.pov, 'white') : null;
  };
  const startChances = chancesAt(0);
  if (!startChances) return [];
  const points: GraphPoint[] = [{ ply: 0, percent: startChances.percent, label: `Start: ${startChances.text}` }];
  for (const [i, m] of moves.entries()) {
    const chances = chancesAt(i + 1);
    if (!chances) continue;
    const point: GraphPoint = { ply: m.ply, percent: chances.percent, label: `${moveLabel(m.fenBefore, m.san)}: ${chances.text}` };
    if (isMarked(m.grade)) point.mark = { grade: m.grade, side: m.side, name: `${m.grade} by ${SIDE_NAMES[m.side]}, move ${moveNumberOf(m.fenBefore)}` };
    points.push(point);
  }
  return points;
}
