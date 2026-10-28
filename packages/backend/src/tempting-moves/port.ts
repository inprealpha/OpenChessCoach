// The tempting moves port: the moves a Player would reach for in a position, the obvious ones that
// may be good or may be a mistake. The Engine grades them and the Coach explains them (ADR 0011).
// Three implementations: Maia-3 on the desktop, Opus until the model is downloaded, and a fixed fake
// for verify mode and tests.
import type { CoachUsage } from '@chess-coach/shared/coach/types';

export interface TemptingMovesRequest {
  /** The position the game started from and the moves (UCI) that lead to the position asked about. */
  startFen: string;
  moves: readonly string[];
  /** The rating of the side to move and of its opponent, when known; Maia-3 reads both. */
  rating?: number;
  opponentRating?: number;
  /** How many moves to return; 3 by default. */
  count?: number;
  signal?: AbortSignal;
}

export interface TemptingMoves {
  /** Legal moves in UCI (castling as e1g1), most tempting first, at most `count`. */
  moves: string[];
  /** What a Claude call cost (the Opus side), for the Coach call log. */
  usage?: CoachUsage;
}

export interface TemptingMovesPort {
  readonly name: 'maia' | 'opus' | 'fake';
  suggest(req: TemptingMovesRequest): Promise<TemptingMoves>;
}

/** The rating Maia-3 is given when the Player's isn't known: the middle of the Lichess pool. */
export const DEFAULT_RATING = 1500;
