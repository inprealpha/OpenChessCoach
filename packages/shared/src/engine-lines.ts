// The Engine's lines as the Board shows them: each line's moves with their move numbers, as a
// scoresheet writes them ("14. Nxd5 Qxd5 15. c4", "14… Qxd5 15. c4" when Black starts), and its
// Winning Chances, which are always White's, as on the Winning Chances bar, the Review's graph and
// Lichess (#52). One place, so the lines, the bar and the journeys never disagree about the side.
import { moveNumberOf, playLine, turnOf, type PlayedMove, type Side } from './chess.ts';
import type { EngineLine, Score } from './engine.ts';
import { winningChancesFor, type WinningChances } from './winning-chances.ts';

/** The side every percentage on a board belongs to: White's, whoever is to move or at the bottom. */
export const BOARD_SIDE: Side = 'white';

/**
 * Winning Chances as a board shows them, on the bar and in the Engine lines: White's, from an
 * Engine score seen from `pov`'s point of view (the side to move, for an Engine line).
 */
export function boardChances(score: Score, pov: Side): WinningChances {
  return winningChancesFor(score, pov, BOARD_SIDE);
}

/** One move of an Engine line, ready to show and to play. */
export interface LineMove extends PlayedMove {
  /** The move number before it, as a scoresheet writes it: "14." for White, "14…" for a line's first move by Black, otherwise "". */
  number: string;
  /** The move with its number, where it has one: "14. Nxd5", "Qxd5", "14… Qxd5". */
  label: string;
}

/** A line's moves shown on the board for a moment, up to and including `moves.at(-1)`. */
export interface LinePreview {
  moves: LineMove[];
  /** "1. e4 e5 2. Nf3". */
  text: string;
}

export interface EngineLineView {
  moves: LineMove[];
  /** The whole line as text: "14. Nxd5 Qxd5 15. c4". */
  text: string;
  /** White's Winning Chances after the line's first move. */
  chances: WinningChances;
}

/** A line of moves from `fen` with their move numbers: White's always, Black's only on the line's first move. */
export function numberedMoves(fen: string, ucis: readonly string[]): LineMove[] {
  return playLine(fen, ucis).map((m, i) => {
    const white = turnOf(m.fenBefore) === 'white';
    const number = white ? `${moveNumberOf(m.fenBefore)}.` : i === 0 ? `${moveNumberOf(m.fenBefore)}…` : '';
    return { ...m, number, label: number ? `${number} ${m.san}` : m.san };
  });
}

/** How many of a line's moves the Board shows: enough to see the idea, few enough for one row. */
export const SHOWN_PLIES = 6;

/** An Engine line from `fen` as the Board shows it: its first moves, numbered, and White's Winning Chances. */
export function engineLineView(fen: string, line: Pick<EngineLine, 'pv' | 'score'>, plies = SHOWN_PLIES): EngineLineView {
  const moves = numberedMoves(fen, line.pv.slice(0, plies));
  return { moves, text: moves.map((m) => m.label).join(' '), chances: boardChances(line.score, turnOf(fen)) };
}
