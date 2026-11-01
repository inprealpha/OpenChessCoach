// Who a game's Review speaks to, and at what level (#33). A game from Lichess or chess.com records
// each player's rating for that game; with "Pitch each Review at the game's rating" on in the Player
// Profile, the Coach pitches the game's Review, and Why Questions about it, at the rating of the
// side the Review follows, and Maia-3 guesses tempting moves at that rating too (ADR 0011). Without
// one, or with it off, the Player Profile's level and rating apply, as before. A game the owner
// didn't play is told about as White's or Black's game, never as "you".
import { otherSide, type Side } from '@chess-coach/shared/chess';
import type { GamePitch } from '@chess-coach/shared/coach/types';
import { bandFor } from '@chess-coach/shared/content/lessons';
import type { GameDetail, PlayerProfile, RatingSite } from '@chess-coach/shared/protocol';
import { sideOf } from '@chess-coach/shared/pgn';
import type { Db } from './db.ts';
import { getProfile } from './profile.ts';
import { maiaRating, playerMaiaRating } from './tempting-moves/rating.ts';

/** What a game's record says about its players' ratings: each side's, the site and the rating pool. */
export interface GameRatings {
  white?: number;
  black?: number;
  site?: RatingSite;
  /** The site's name for the pool, as the Player Profile records it: "blitz" on Lichess, "chess_blitz" on chess.com. */
  pool?: string;
}

/** A PGN's headers, read without replaying its moves. */
export function pgnHeaders(pgn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of pgn.matchAll(/^\s*\[(\w+)\s+"((?:\\.|[^"\\])*)"\s*\]\s*$/gm)) out[m[1] as string] = (m[2] as string).replace(/\\(.)/g, '$1');
  return out;
}

function elo(value: string | undefined): number | undefined {
  // Lichess writes "?" for a player with no rating, and a few sites write 0.
  const n = value && /^\d{1,4}$/.test(value.trim()) ? Number(value) : 0;
  return n >= 100 && n <= 3500 ? n : undefined;
}

/** Where a game was played: its source, or for a pasted PGN, the site its headers name. */
function siteOf(game: Pick<GameDetail, 'source'>, headers: Record<string, string>): RatingSite | undefined {
  if (game.source === 'lichess' || game.source === 'chesscom') return game.source;
  const site = headers.Site?.toLowerCase() ?? '';
  if (site.includes('lichess.org')) return 'lichess';
  if (site.includes('chess.com')) return 'chesscom';
  return undefined;
}

const LICHESS_POOLS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

/**
 * The rating pool of a game's time control, by each site's rule: the base time plus 40 times the
 * increment, in seconds. Lichess: under 30 ultra-bullet, 180 bullet, 480 blitz, 1500 rapid, then
 * classical; chess.com: under 180 bullet, 600 blitz, then rapid. Daily and correspondence games
 * have no clock per move ("-", or "1/86400" on chess.com).
 */
export function poolOf(site: RatingSite, timeControl: string | undefined): string | undefined {
  const tc = timeControl?.trim();
  if (!tc) return undefined;
  if (tc === '-' || tc.includes('/')) return site === 'lichess' ? 'correspondence' : 'chess_daily';
  const m = tc.match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return undefined;
  const total = Number(m[1]) + 40 * Number(m[2] ?? 0);
  if (site === 'lichess') return total < 30 ? 'ultraBullet' : total < 180 ? 'bullet' : total < 480 ? 'blitz' : total < 1500 ? 'rapid' : 'classical';
  return total < 180 ? 'chess_bullet' : total < 600 ? 'chess_blitz' : 'chess_rapid';
}

/** Each player's rating as the game's record gives it, with its site and pool. */
export function gameRatings(game: Pick<GameDetail, 'source' | 'pgn'>): GameRatings {
  // An Engine Game's PGN is the app's own, and the Engine's strength is no rating.
  if (game.source === 'engine') return {};
  const headers = pgnHeaders(game.pgn);
  const white = elo(headers.WhiteElo);
  const black = elo(headers.BlackElo);
  const site = siteOf(game, headers);
  // Lichess names the pool in its Event ("Rated Blitz game"); otherwise the time control says.
  const named = site === 'lichess' ? headers.Event?.match(/\b(ultraBullet|bullet|blitz|rapid|classical|correspondence)\b/i)?.[1] : undefined;
  const pool = named ? LICHESS_POOLS.find((p) => p.toLowerCase() === named.toLowerCase()) : site ? poolOf(site, headers.TimeControl) : undefined;
  return { ...(white ? { white } : {}), ...(black ? { black } : {}), ...(site ? { site } : {}), ...(pool ? { pool } : {}) };
}

/**
 * Whether the owner played this game. Only a game from the site the Player Profile's account is
 * on can tell: there, a game that names neither side by that username is someone else's, such as a
 * friend's games fetched by their username. Any other game is taken as the owner's, as before.
 */
export function ownersGame(profile: Pick<PlayerProfile, 'ratingSource'>, game: Pick<GameDetail, 'source' | 'pgn'>): boolean {
  const account = profile.ratingSource;
  if (!account || (game.source !== 'lichess' && game.source !== 'chesscom') || game.source !== account.site) return true;
  return sideOf(pgnHeaders(game.pgn), account.username) !== undefined;
}

/** A side's rating on the Lichess blitz scale Maia-3 learned, by ADR 0011's rules for the Profile's rating. */
function maiaFor(rating: number, { site, pool }: GameRatings): number {
  const blitz = pool === 'blitz' || pool === 'chess_blitz' ? rating : undefined;
  return maiaRating({ rating, site, pool, blitz });
}

/** How a game's Review is pitched: its brief's `pitch`, and the ratings Maia-3 is given. */
export interface GamePitchFor {
  /** Undefined when the Player Profile's level and rating apply, and the owner played the game. */
  pitch?: GamePitch;
  /** The rating of the side the Review follows, and of its opponent, for Maia-3. */
  maia: { rating: number; opponentRating?: number };
}

/** The pitch for a game whose Review follows `side` (its Player's side). */
export function gamePitch(db: Db, game: Pick<GameDetail, 'source' | 'pgn' | 'playerSide'>, side: Side = game.playerSide): GamePitchFor {
  const profile = getProfile(db);
  const own = ownersGame(profile, game);
  const ratings = profile.levelFromGames ? gameRatings(game) : {};
  const rating = ratings[side];
  const opponent = ratings[otherSide(side)];
  // The rating's band, as the popularity tables and the Course read a rating (`bandFor`).
  const pitch: GamePitch = { ...(rating ? { level: bandFor(profile.level, rating), rating } : {}), ...(own ? {} : { ownGame: false as const }) };
  return {
    ...(Object.keys(pitch).length ? { pitch } : {}),
    maia: rating ? { rating: maiaFor(rating, ratings), ...(opponent ? { opponentRating: maiaFor(opponent, ratings) } : {}) } : { rating: playerMaiaRating(db) },
  };
}
