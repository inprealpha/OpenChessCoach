// Arrows the Board draws besides the Coach's: each with its own color and accessible name.
import type { GradedMove } from '@chess-coach/shared/analysis';
import { piecesOf, SIDE_NAMES, type Side } from '@chess-coach/shared/chess';
import type { Arrow } from '@chess-coach/shared/coach/types';
import type { Threat } from '@chess-coach/shared/threat';
import { GRADE_LOOK } from './grades.ts';

/** An arrow on the board: one of the Coach's (named by its brush), or one with its own color and name. */
export type BoardArrow = Arrow | { from: string; to: string; color: string; label: string };

/** The Engine's best move, and the Coach's green arrows. */
export const BEST_COLOR = '#15781b';

/** The opponent's threat. */
export const THREAT_COLOR = '#d32f2f';

/**
 * The threat arrow, when Threat is on and the Engine found one: the opponent's best move if they
 * could move now, in red. Callers put it first, so other arrows draw over it.
 */
export function threatArrows(threat: Pick<Threat, 'side' | 'uci' | 'san'> | null | undefined): BoardArrow[] {
  if (!threat) return [];
  const from = threat.uci.slice(0, 2);
  const to = threat.uci.slice(2, 4);
  return [{ from, to, color: THREAT_COLOR, label: `Threat: ${SIDE_NAMES[threat.side]} threatens ${threat.san} (${from} to ${to})` }];
}

/**
 * A Review's arrows for one graded move: the move played, in its Move Grade's color (the dark one
 * of its badge), and the Engine's best in green; one green arrow when they are the same move.
 * Drawn only from what the Review already carries, so they cost no Engine time (ADR 0002).
 */
export function reviewArrows(move: GradedMove | undefined): BoardArrow[] {
  if (!move) return [];
  const best = move.candidates[0];
  const from = move.uci.slice(0, 2);
  const to = move.uci.slice(2, 4);
  if (!best || best.uci === move.uci) {
    const label = `Move played: ${move.san}, ${move.grade}${best ? ', the Engine’s best' : ''}`;
    return [{ from, to, color: best ? BEST_COLOR : GRADE_LOOK[move.grade].dark, label }];
  }
  return [
    { from, to, color: GRADE_LOOK[move.grade].dark, label: `Move played: ${move.san}, ${move.grade}` },
    { from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), color: BEST_COLOR, label: `Engine’s best: ${best.san}` },
  ];
}

/**
 * A Lesson's Coach arrows: the move on the board (`played`) and the opponent's moves, never another
 * move for the Player, who plays `player`. Even the Engine's top choice may be the answer to the
 * Lesson's next decision. Only the arrows: the Coach's words may still name other moves (ADR 0012).
 */
export function lessonArrows<A extends { from: string; to: string }>(arrows: readonly A[], fen: string, played: string | undefined, player: Side): A[] {
  const theirs = new Set(piecesOf(fen).filter((p) => p.color !== player).map((p) => p.square));
  return arrows.filter((a) => `${a.from}${a.to}` === played?.slice(0, 4) || theirs.has(a.from));
}
