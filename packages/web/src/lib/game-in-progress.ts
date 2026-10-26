// The Engine Game this device has in progress, for the main menu's Continue your game. The Engine
// Game screen keeps its game under this key and deletes it on New game; a finished game keeps its
// result until then, so it isn't in progress.
import { INITIAL_FEN, moveNumberOf, outcomeOf, playLine, type Side } from '@chess-coach/shared/chess';
import { store } from './storage.ts';

/** The key the Engine Game screen keeps its game under. */
const KEY = 'engineGame';

export interface GameInProgress {
  playerSide: Side;
  /** The move number the game is at, as the move list counts them. */
  moveNumber: number;
}

/**
 * A saved Engine Game as a game to continue, replayed move by move from the start. Null for a game
 * with a result, one whose moves can't all be played, and one already over on the board: the app
 * can close after the last move is saved but before the result is.
 */
export function continuable(saved: unknown): GameInProgress | null {
  if (!saved || typeof saved !== 'object') return null;
  const g = saved as { playerSide?: unknown; moves?: unknown; result?: unknown };
  if (g.result || (g.playerSide !== 'white' && g.playerSide !== 'black')) return null;
  if (!Array.isArray(g.moves) || !g.moves.every((m) => typeof m === 'string')) return null;
  const played = playLine(INITIAL_FEN, g.moves);
  const fen = played.at(-1)?.fenAfter ?? INITIAL_FEN;
  if (played.length !== g.moves.length || outcomeOf(fen)) return null;
  return { playerSide: g.playerSide, moveNumber: moveNumberOf(fen) };
}

export async function gameInProgress(): Promise<GameInProgress | null> {
  return continuable(await store.get(KEY));
}
