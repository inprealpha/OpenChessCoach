// The score of a position in a Review: one number per position, read by the Winning Chances bar,
// the Winning Chances graph and the key moments alike, so they never disagree.
// A position reached by a graded move takes the score that move's Move Grade was computed from
// (ADR 0002): no new data and no Engine run (ADR 0007).
import type { GradedMove } from './analysis.ts';
import { outcomeOf, turnOf, type Side } from './chess.ts';
import type { Score } from './engine.ts';

export interface PositionScore {
  score: Score;
  /** The side whose point of view `score` is from. */
  pov: Side;
}

/** A finished game needs no Engine: checkmate is mate on the board, anything else is a draw. */
export function finishedScore(fen: string): PositionScore | null {
  const outcome = outcomeOf(fen);
  if (!outcome) return null;
  return { score: outcome.reason === 'checkmate' ? { mate: 0 } : { cp: 0 }, pov: turnOf(fen) };
}

/**
 * The score of the position `ply` plies into a graded game: after a move, the score that graded
 * it (its `playedScore`, from the mover's point of view); at the start, the Engine's best line
 * there. Null outside the game.
 */
export function scoreAfterPly(moves: readonly GradedMove[], ply: number): PositionScore | null {
  if (ply === 0) {
    const first = moves[0];
    const best = first?.candidates[0];
    return first && best ? { score: best.score, pov: first.side } : null;
  }
  const move = moves[ply - 1];
  if (!move || ply < 0) return null;
  return finishedScore(move.fenAfter) ?? { score: move.playedScore, pov: move.side };
}
