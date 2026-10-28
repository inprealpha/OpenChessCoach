// The rating Maia-3 is given (ADR 0011). It learned from Lichess blitz games, so it reads a rating on
// that scale. The Player Profile holds the Player's rating from Lichess or chess.com, their rapid one
// when they have it. A Lichess rating is used as it is; a chess.com rapid rating is converted.
import type { RatingSite } from '@chess-coach/shared/protocol';
import { DEFAULT_RATING } from './port.ts';

/**
 * chess.com rapid against Lichess blitz, from ChessGoals' rating comparison (updated July 2026,
 * https://chessgoals.com/rating-comparison/): its two tables keyed on chess.com blitz, chess.com
 * rapid (N=10,156) and Lichess blitz (N=1,935), joined on that key, every other row.
 */
const CHESSCOM_RAPID_TO_LICHESS_BLITZ: readonly (readonly [number, number])[] = [
  [815, 1090],
  [995, 1225],
  [1170, 1360],
  [1340, 1490],
  [1500, 1620],
  [1655, 1755],
  [1800, 1885],
  [1935, 2015],
  [2055, 2145],
  [2165, 2275],
  [2260, 2410],
  [2340, 2540],
  [2430, 2745],
];

/**
 * The Player's rating on the Lichess blitz scale: straight lines between the table's rows, and the
 * nearest row's difference beyond its ends. 1500 when there is none.
 */
export function maiaRating(rating: number | null | undefined, site: RatingSite | undefined): number {
  if (!rating || !Number.isFinite(rating)) return DEFAULT_RATING;
  if (site !== 'chesscom') return Math.round(rating);
  const table = CHESSCOM_RAPID_TO_LICHESS_BLITZ;
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (rating <= first[0]) return Math.round(rating + first[1] - first[0]);
  if (rating >= last[0]) return Math.round(rating + last[1] - last[0]);
  const upper = table.findIndex(([from]) => from >= rating);
  const [x0, y0] = table[upper - 1]!;
  const [x1, y1] = table[upper]!;
  return Math.round(y0 + ((rating - x0) * (y1 - y0)) / (x1 - x0));
}
