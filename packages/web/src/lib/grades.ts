// How Move Grades look, shared by the badges in move lists and the symbols on the board, so the two
// always use the same colors.
import type { MoveGrade } from '@chess-coach/shared/grader';

export interface GradeLook {
  /** The familiar notation: `?!`, `?`, `??`, a star for Best. */
  symbol: string;
  /** Light background of a badge; the glyph's color on the board. */
  light: string;
  /** Dark text of a badge; the symbol's fill on the board. */
  dark: string;
}

export const GRADE_LOOK: Record<MoveGrade, GradeLook> = {
  Best: { symbol: '★', light: '#d9f2df', dark: '#145c26' },
  Good: { symbol: '✓', light: '#e3f0e6', dark: '#2c6b3a' },
  Inaccuracy: { symbol: '?!', light: '#fff2cc', dark: '#7a5a00' },
  Mistake: { symbol: '?', light: '#ffe0c2', dark: '#8a3d00' },
  Blunder: { symbol: '??', light: '#ffd6d6', dark: '#8a0000' },
};

/** A Move Grade drawn on the square its move landed on. */
export interface GradeMark {
  square: string;
  grade: MoveGrade;
}

/**
 * The mark for a graded move, or nothing when the move has no Move Grade yet. Only a Move Grade the
 * Engine gave is ever drawn (ADR 0002); the board leaves Good moves unmarked.
 */
export function gradeMark(move: { uci: string } | undefined, grade: MoveGrade | undefined): GradeMark | undefined {
  if (!move || !grade) return undefined;
  return { square: move.uci.slice(2, 4), grade };
}

/** Several of a Move Grade, as the app writes them: "2 Inaccuracies", "3 Blunders", "2 Best". */
const MANY: Record<MoveGrade, string> = { Best: 'Best', Good: 'Good', Inaccuracy: 'Inaccuracies', Mistake: 'Mistakes', Blunder: 'Blunders' };

/** A count of one Move Grade: "1 Blunder", "2 Blunders". */
export function gradeCount(n: number, grade: MoveGrade): string {
  return `${n} ${n === 1 ? grade : MANY[grade]}`;
}
