// Picks the 3 to 5 key moments of a graded game for a Review (ADR 0004), and the moves that stood
// out on both sides for the Review's overview.
import type { GradedMove } from './analysis.ts';
import type { Side } from './chess.ts';
import { GRADE_THRESHOLDS, gradeRank, isBadGrade, winningChances } from './grader.ts';

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

/** The most standout moves a Review's overview is told about (ADR 0004). */
export const MAX_STANDOUTS = 8;

/** A move that stood out in a game, and why: a Mistake or Blunder, or the only good move. */
export interface Standout {
  move: GradedMove;
  /** A Best move where the Engine's next-best move would have given up at least a Mistake's worth. */
  only: boolean;
}

/**
 * The winning chance the Engine's next-best move would have given up in the move's position, when
 * the move played is the Engine's best and the Engine listed another; 0 otherwise.
 */
function onlyMoveGap(move: GradedMove): number {
  const [best, next] = move.candidates;
  if (!best || !next || move.grade !== 'Best' || best.uci !== move.uci) return 0;
  return Math.max(0, winningChances(best.score) - winningChances(next.score));
}

/** Takes back a piece just taken on the same square: the natural move, however much the others lose. */
function isRecapture(move: GradedMove, previous: GradedMove | undefined): boolean {
  return Boolean(previous && previous.san.includes('x') && move.san.includes('x') && previous.uci.slice(2, 4) === move.uci.slice(2, 4));
}

/**
 * The moves that stood out on both sides, from the Engine's facts alone (ADR 0002): every Mistake
 * and Blunder, and every Best move where every other move the Engine listed was much worse (a
 * Mistake's worth of winning chance or more), skipping recaptures and moves played once the game
 * was decided, and the moves at `except` (the key moments, which a Review already lists). At most
 * `MAX_STANDOUTS`, the costliest errors and the widest gaps first, returned in game order. There is
 * no Move Grade above Best: an only move is still graded Best.
 */
export function pickStandouts(moves: readonly GradedMove[], except: ReadonlySet<number> = new Set()): Standout[] {
  const out: { standout: Standout; weight: number }[] = [];
  for (const [i, move] of moves.entries()) {
    if (isDecided(move) || except.has(move.ply)) continue;
    if (isBadGrade(move.grade)) out.push({ standout: { move, only: false }, weight: move.winLoss });
    else {
      const gap = onlyMoveGap(move);
      if (gap >= GRADE_THRESHOLDS.Mistake && !isRecapture(move, moves[i - 1])) out.push({ standout: { move, only: true }, weight: gap });
    }
  }
  return out
    .sort((a, b) => b.weight - a.weight || a.standout.move.ply - b.standout.move.ply)
    .slice(0, MAX_STANDOUTS)
    .map((o) => o.standout)
    .sort((a, b) => a.move.ply - b.move.ply);
}
