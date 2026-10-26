// Winning Chances: the Grader's winning chances as the percentage the Player reads.
// They come from the same numbers the Move Grades use, never from Stockfish's own win/draw/loss
// output, so what the Player reads always agrees with the Move Grade (ADR 0002). One formatter for
// every screen and the Coach's brief, so nothing phrases or rounds them differently.
import { otherSide, SIDE_NAMES, type Side } from './chess.ts';
import type { Score } from './engine.ts';
import { formatScore, negateScore, winningChances } from './grader.ts';

export interface Mate {
  /** The side that gives mate. */
  winner: Side;
  /** Moves until mate; 0 when the position is already checkmate. */
  moves: number;
}

export interface WinningChances {
  /** The side these Winning Chances are for. */
  side: Side;
  /** 0 to 100, unrounded: 50 plus 50 times the Grader's winning chances for `side`. */
  percent: number;
  /** The forced mate, when the Engine sees one. */
  mate?: Mate;
  /** The full phrase: "White’s winning chances: 68%", or a mate phrase such as "White mates in 3". */
  text: string;
  /** The compact form for tight spaces: "68%", or the mate phrase. */
  short: string;
  /** The evaluation from `side`'s point of view: "+1.40", or "M3" / "-M3" for a mate. */
  evaluation: string;
}

/** "White mates in 3", or "White has checkmated" once the mate is on the board. */
export function matePhrase(mate: Mate): string {
  return mate.moves === 0 ? `${SIDE_NAMES[mate.winner]} has checkmated` : `${SIDE_NAMES[mate.winner]} mates in ${mate.moves}`;
}

/**
 * Winning Chances for `side`, from an Engine score seen from `pov`'s point of view (the side to
 * move for a candidate line, the mover for a played move's score).
 */
export function winningChancesFor(score: Score, pov: Side, side: Side = pov): WinningChances {
  const own = side === pov ? score : negateScore(score);
  // Read from `pov`, then turned round: mate 0 (`pov` is checkmated) has no negative to turn into.
  const percent = 50 + 50 * (side === pov ? 1 : -1) * winningChances(score);
  const evaluation = formatScore(own);
  if (score.mate !== undefined) {
    // A positive mate is `pov` giving mate; zero or negative is `pov` getting mated.
    const mate: Mate = score.mate > 0 ? { winner: pov, moves: score.mate } : { winner: otherSide(pov), moves: Math.abs(score.mate) };
    const text = matePhrase(mate);
    return { side, percent, mate, text, short: text, evaluation };
  }
  const short = `${Math.round(percent)}%`;
  return { side, percent, text: `${SIDE_NAMES[side]}’s winning chances: ${short}`, short, evaluation };
}
