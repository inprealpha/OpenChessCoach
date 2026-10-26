// Threats: what the opponent wants to do next. The Engine searches the position with the side to
// move swapped (a null move) and the opponent's best move there is the threat. It counts only when
// it is forcing (a capture, a check or a promotion) and would cost the side to move at least an
// Inaccuracy's worth of winning chances, by the Grader's thresholds, so a threat is never shown or
// briefed when it doesn't matter (ADR 0002). The forcing rule is there because a free move is worth
// more than an Inaccuracy in the opening on its own: from the start position, letting Black play
// 1...e5 for free costs White 0.14 winning chances, and that is a tempo, not a threat.
import { isCheck, isValidFen, outcomeOf, turnOf, uciToSan, type Side } from './chess.ts';
import type { Analysis, Score } from './engine.ts';
import { GRADE_THRESHOLDS, negateScore, winningChances } from './grader.ts';

export interface Threat {
  /** The side that threatens: the side not to move. */
  side: Side;
  /** The threatening move in UCI, as the opponent would play it if they could move now. */
  uci: string;
  san: string;
  /** The Engine's line after the threat, in UCI, starting with it. */
  pv: string[];
  /** The Engine's score of the threat, from the threatening side's point of view. */
  score: Score;
  /** Winning chances the side to move would lose by letting the threat happen, never negative. */
  winLoss: number;
}

/**
 * The position with the other side to move: the side to move "passes". No en passant capture is
 * possible after a pass. Returns undefined when that position is not legal.
 */
export function nullMoveFen(fen: string): string | undefined {
  const parts = fen.split(' ');
  if (parts.length < 4) return undefined;
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  const swapped = parts.join(' ');
  return isValidFen(swapped) ? swapped : undefined;
}

/**
 * The opponent's threat in a position, or undefined when there is none worth showing: the side to
 * move is in check, the game is over, or the threat costs less than an Inaccuracy. `analyse` is the
 * Engine's analysis at the caller's settings, so a position it already analysed costs nothing again.
 * After the pass only the best line counts, so `analyse` is asked for one line there: a search for
 * one line takes a fraction of the time of five.
 */
export async function findThreat(analyse: (fen: string, multiPv?: number) => Promise<Analysis>, fen: string): Promise<Threat | undefined> {
  if (!isValidFen(fen) || outcomeOf(fen) || isCheck(fen)) return undefined;
  const swapped = nullMoveFen(fen);
  if (!swapped || outcomeOf(swapped)) return undefined;
  const now = (await analyse(fen)).lines[0];
  const passed = (await analyse(swapped, 1)).lines[0];
  const uci = passed?.pv[0];
  if (!now || !passed || !uci) return undefined;
  const san = uciToSan(swapped, uci);
  if (!san) return undefined;
  const winLoss = Math.max(0, winningChances(now.score) - winningChances(negateScore(passed.score)));
  if (winLoss < GRADE_THRESHOLDS.Inaccuracy || !isForcing(san)) return undefined;
  return { side: turnOf(swapped), uci, san, pv: passed.pv, score: passed.score, winLoss };
}

/** A capture, a check or a promotion, read from the move's SAN. */
export function isForcing(san: string): boolean {
  return /[x+#=]/.test(san);
}
