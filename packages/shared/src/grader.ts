// Move Grades from winning chances, the way Lichess judges moves (ADR 0002).
// A move's rank among the Engine's candidates never enters the grade.
import type { Score } from './engine.ts';

export const MOVE_GRADES = ['Best', 'Good', 'Inaccuracy', 'Mistake', 'Blunder'] as const;
export type MoveGrade = (typeof MOVE_GRADES)[number];

/** Lichess's thresholds on winning chance lost (winning chances run from -1 to 1). */
export const GRADE_THRESHOLDS = { Inaccuracy: 0.1, Mistake: 0.2, Blunder: 0.3 } as const;

/**
 * The material floor: a move that gives up this many centipawns or more against the best move is
 * at least a Mistake, even when the game is already decided and the winning chance barely moves.
 * Lichess's formula alone would call hanging a piece a queen down Good (ADR 0002, 2026-10-13 note).
 * A move after which the Engine still reports a forced mate gives nothing away, however much
 * later the mate comes, so the floor leaves it to the formula, as Lichess does. A mate beyond the
 * Engine's depth reads as a big centipawn score, and the floor still applies.
 */
export const MATERIAL_FLOOR_CP = 300;

const MULTIPLIER = -0.00368208;
const CP_CEILING = 1000;

/** Centipawns for a score, with mates mapped the way Lichess does. */
export function scoreToCp(score: Score): number {
  if (score.mate !== undefined) {
    if (score.mate === 0) return -2100;
    return (21 - Math.min(10, Math.abs(score.mate))) * 100 * Math.sign(score.mate);
  }
  return score.cp;
}

/** Winning chances in [-1, 1] for the side whose point of view the score is from. */
export function winningChances(score: Score): number {
  const cp = Math.max(-CP_CEILING, Math.min(CP_CEILING, scoreToCp(score)));
  return 2 / (1 + Math.exp(MULTIPLIER * cp)) - 1;
}

export function negateScore(score: Score): Score {
  return score.mate !== undefined ? { mate: -score.mate } : { cp: -score.cp };
}

export interface GradeInput {
  /** Score of the Engine's best move, from the mover's point of view. */
  best: Score;
  /** Score after the played move, from the mover's point of view. */
  played: Score;
  /** Whether the played move is the Engine's top move. */
  isTopMove: boolean;
}

export interface GradeResult {
  grade: MoveGrade;
  /** Winning chance given up compared with the best move, never negative. */
  winLoss: number;
}

export function gradeMove(input: GradeInput): GradeResult {
  const winLoss = Math.max(0, winningChances(input.best) - winningChances(input.played));
  // A move that gives checkmate (a mate in one, from before it) ends the game: nothing is better,
  // whichever mate the Engine lists first.
  if (input.isTopMove || input.played.mate === 1) return { grade: 'Best', winLoss: 0 };
  if (winLoss >= GRADE_THRESHOLDS.Blunder) return { grade: 'Blunder', winLoss };
  if (winLoss >= GRADE_THRESHOLDS.Mistake) return { grade: 'Mistake', winLoss };
  const stillMates = input.played.mate !== undefined && input.played.mate > 0;
  if (!stillMates && scoreToCp(input.best) - scoreToCp(input.played) >= MATERIAL_FLOOR_CP) return { grade: 'Mistake', winLoss };
  if (winLoss >= GRADE_THRESHOLDS.Inaccuracy) return { grade: 'Inaccuracy', winLoss };
  return { grade: 'Good', winLoss };
}

/** Formats a score from the side to move as "+0.45" or "M3" / "-M2". */
export function formatScore(score: Score): string {
  if (score.mate !== undefined) return score.mate >= 0 ? `M${score.mate}` : `-M${-score.mate}`;
  const pawns = score.cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

export function isBadGrade(grade: MoveGrade): boolean {
  return grade === 'Mistake' || grade === 'Blunder';
}

export function gradeRank(grade: MoveGrade): number {
  return MOVE_GRADES.indexOf(grade);
}
