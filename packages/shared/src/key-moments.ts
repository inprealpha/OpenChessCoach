// Picks the 3 to 5 key moments of a graded game for a Review (ADR 0004).
import type { GradedMove } from './analysis.ts';
import type { Side } from './chess.ts';
import { gradeRank, winningChances } from './grader.ts';

export const MAX_KEY_MOMENTS = 5;
/** Winning chances beyond this mean the game was already decided. */
export const DECIDED = 0.9;

export function isDecided(move: GradedMove): boolean {
  const best = move.candidates[0];
  if (!best) return true;
  const before = winningChances(best.score);
  const after = winningChances(move.playedScore);
  if (before <= -DECIDED) return true;
  return before >= DECIDED && after >= DECIDED;
}

/**
 * Chooses the Player's moves that lost the most winning chance, skipping moves played
 * when the game was already decided. Returns them in game order, at most five, and fewer
 * when the game had fewer real mistakes.
 */
export function pickKeyMoments(moves: readonly GradedMove[], playerSide: Side): GradedMove[] {
  const candidates = moves.filter(
    (m) => m.side === playerSide && gradeRank(m.grade) >= gradeRank('Inaccuracy') && !isDecided(m),
  );
  return [...candidates]
    .sort((a, b) => b.winLoss - a.winLoss || a.ply - b.ply)
    .slice(0, MAX_KEY_MOMENTS)
    .sort((a, b) => a.ply - b.ply);
}
