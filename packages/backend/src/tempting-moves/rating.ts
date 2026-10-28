// The rating Maia-3 is given (ADR 0011). It learned from Lichess blitz games, so it reads a rating on
// that scale. The Player Profile shows the Player's rating from Lichess or chess.com, from the first
// pool they have played (rapid first); the desktop also records which pool that is and their blitz
// rating there. Maia-3 gets, in order:
//   - the blitz rating: Lichess blitz as it is, chess.com blitz converted;
//   - else the Profile's rating when its pool converts soundly: Lichess rapid as it is (the nearest
//     pool on the same site), chess.com rapid converted;
//   - else 1500: Lichess classical, bullet or correspondence, chess.com daily or bullet, and a
//     rating linked before the desktop recorded its pool.
import type { RatingSite } from '@chess-coach/shared/protocol';
import type { Db } from '../db.ts';
import { getProfile } from '../profile.ts';
import { DEFAULT_RATING } from './port.ts';

type Table = readonly (readonly [number, number])[];

/**
 * chess.com rapid and blitz against Lichess blitz, from ChessGoals' rating comparison (updated July
 * 2026, https://chessgoals.com/rating-comparison/): its two tables keyed on chess.com blitz, with
 * chess.com rapid (N=10,156) and Lichess blitz (N=1,935), joined on that key, every other row.
 */
const CHESSCOM_RAPID_TO_LICHESS_BLITZ: Table = [
  [815, 1090], [995, 1225], [1170, 1360], [1340, 1490], [1500, 1620], [1655, 1755], [1800, 1885],
  [1935, 2015], [2055, 2145], [2165, 2275], [2260, 2410], [2340, 2540], [2430, 2745],
];
const CHESSCOM_BLITZ_TO_LICHESS_BLITZ: Table = [
  [500, 1090], [700, 1225], [900, 1360], [1100, 1490], [1300, 1620], [1500, 1755], [1700, 1885],
  [1900, 2015], [2100, 2145], [2300, 2275], [2500, 2410], [2700, 2540], [3000, 2745],
];

/** Straight lines between a table's rows, and the nearest row's difference beyond its ends. */
function convert(table: Table, rating: number): number {
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (rating <= first[0]) return Math.round(rating + first[1] - first[0]);
  if (rating >= last[0]) return Math.round(rating + last[1] - last[0]);
  const upper = table.findIndex(([from]) => from >= rating);
  const [x0, y0] = table[upper - 1]!;
  const [x1, y1] = table[upper]!;
  return Math.round(y0 + ((rating - x0) * (y1 - y0)) / (x1 - x0));
}

export interface PlayerRating {
  rating: number | null;
  site?: RatingSite | undefined;
  /** The site's pool `rating` is from ("rapid", "chess_daily"…); unknown for a rating linked before it was recorded. */
  pool?: string | null | undefined;
  /** The Player's blitz rating on the site, when they have played blitz there. */
  blitz?: number | null | undefined;
}

/** The Player's rating on the Lichess blitz scale Maia-3 learned, by the rules above. */
export function maiaRating({ rating, site, pool, blitz }: PlayerRating): number {
  if (blitz && Number.isFinite(blitz)) return site === 'chesscom' ? convert(CHESSCOM_BLITZ_TO_LICHESS_BLITZ, blitz) : Math.round(blitz);
  if (!rating || !Number.isFinite(rating)) return DEFAULT_RATING;
  if (site === 'lichess' && (pool === 'rapid' || pool === 'blitz')) return Math.round(rating);
  if (site === 'chesscom' && pool === 'chess_rapid') return convert(CHESSCOM_RAPID_TO_LICHESS_BLITZ, rating);
  return DEFAULT_RATING;
}

/** The Player's rating for Maia-3, from the Player Profile and the pools the desktop recorded. */
export function playerMaiaRating(db: Db): number {
  const profile = getProfile(db);
  const pools = db.prepare('SELECT pool, blitz FROM rating_pools WHERE id = 1').get() as { pool: string | null; blitz: number | null } | undefined;
  return maiaRating({ rating: profile.rating, site: profile.ratingSource?.site, pool: pools?.pool, blitz: pools?.blitz });
}
