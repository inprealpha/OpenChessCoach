// Imported Games and Engine Games, stored side by side in one table.
import { INITIAL_FEN, playLine, type Side } from '@chess-coach/shared/chess';
import { makeSimplePgn, movesHash, parseSinglePgn, PgnImportError, sideOf, type ParsedGame } from '@chess-coach/shared/pgn';
import { ENGINE_LEVEL_NAMES, type EngineGameRecord, type GameDetail, type GameSource, type GameSummary } from '@chess-coach/shared/protocol';
import { SAMPLE_GAME_PGN, SAMPLE_GAME_SIDE } from '@chess-coach/shared/sample-game';
import { type Clock, iso } from './clock.ts';
import { all, one, type Db } from './db.ts';
import { AppError } from './errors.ts';
import { openingName } from './openings.ts';
import { getProfile } from './profile.ts';

interface GameRow {
  id: number;
  kind: string;
  source: GameSource;
  source_id: string;
  pgn: string;
  start_fen: string;
  moves: string;
  white: string;
  black: string;
  player_side: Side;
  result: string;
  opening: string;
  played_at: string;
  date_known: number;
  has_review: number;
}

const SELECT = `SELECT g.*, (SELECT COUNT(*) FROM reviews r WHERE r.game_id = g.id) AS has_review FROM games g`;

/** Engine Games saved before the levels were named say "Engine (level 2)": they read with the name. */
const NUMBERED_ENGINE = /^Engine \(level (\d+)\)$/;

function toSummary(r: GameRow): GameSummary {
  const named = (player: string): string => {
    const level = r.source === 'engine' ? NUMBERED_ENGINE.exec(player)?.[1] : undefined;
    return level ? ENGINE_NAME(Number(level)) : player;
  };
  const white = named(r.white);
  const black = named(r.black);
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    white,
    black,
    playerSide: r.player_side,
    opponent: r.player_side === 'white' ? black : white,
    result: r.result,
    opening: r.opening,
    date: r.date_known ? r.played_at : null,
    hasReview: r.has_review > 0,
  };
}

/** Games newest first: `limit` of them after skipping `offset`, or all of them without a limit. */
export function listGames(db: Db, offset = 0, limit = -1): GameSummary[] {
  return all<GameRow>(db, `${SELECT} ORDER BY g.played_at DESC, g.id DESC LIMIT ? OFFSET ?`, limit, offset).map(toSummary);
}

export function countGames(db: Db): number {
  return one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM games')?.n ?? 0;
}

function gameRow(db: Db, id: number): GameRow {
  const row = one<GameRow>(db, `${SELECT} WHERE g.id = ?`, id);
  if (!row) throw new AppError('not-found', 'That game is not in your game list.');
  return row;
}

export function getGame(db: Db, id: number): GameDetail {
  const row = gameRow(db, id);
  return { ...toSummary(row), pgn: row.pgn, moves: row.moves ? row.moves.split(' ') : [], startFen: row.start_fen };
}

function findBySource(db: Db, source: GameSource, sourceId: string): GameSummary | undefined {
  const row = one<GameRow>(db, `${SELECT} WHERE g.source = ? AND g.source_id = ?`, source, sourceId);
  return row ? toSummary(row) : undefined;
}

/**
 * The day a game was played, from its PGN headers; undefined when they don't give one or give a
 * day that doesn't exist (such as 2020.02.30), which is shown as unknown like a missing date.
 */
export function headerDate(headers: Record<string, string>): string | undefined {
  const raw = headers.UTCDate ?? headers.Date;
  const m = raw?.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  const t = headers.UTCTime?.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  const validTime = t && Number(t[1]) < 24 && Number(t[2]) < 60 && Number(t[3]) < 60;
  return `${m[1]}-${m[2]}-${m[3]}${validTime ? `T${headers.UTCTime}Z` : 'T00:00:00Z'}`;
}

interface InsertGame {
  kind: 'imported' | 'engine';
  source: GameSource;
  sourceId: string;
  pgn: string;
  game: ParsedGame;
  playerSide: Side;
  /** When the game was played, or undefined when that isn't known. */
  playedAt: string | undefined;
}

/** Inserts a game unless one with the same source id exists. */
function insertGame(db: Db, clock: Clock, g: InsertGame): { game: GameSummary; duplicate: boolean } {
  const existing = findBySource(db, g.source, g.sourceId);
  if (existing) return { game: existing, duplicate: true };
  return { game: getGame(db, insertRow(db, clock, g)), duplicate: false };
}

/** A player's name from a PGN header; a PGN writes "?" for a name it doesn't know. */
function knownName(name: string | undefined): string | undefined {
  return name?.trim() && name.trim() !== '?' ? name : undefined;
}

/** Saves a game that isn't in the list yet, and gives its id. */
function insertRow(db: Db, clock: Clock, g: InsertGame): number {
  const opening = openingName(g.game.moves, g.game.startFen, g.game.headers.Opening);
  const info = db
    .prepare(
      `INSERT INTO games (kind, source, source_id, pgn, start_fen, moves, white, black, player_side, result, opening, played_at, date_known, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      g.kind,
      g.source,
      g.sourceId,
      g.pgn,
      g.game.startFen,
      g.game.moves.join(' '),
      knownName(g.game.headers.White) ?? 'White',
      knownName(g.game.headers.Black) ?? 'Black',
      g.playerSide,
      g.game.result,
      opening,
      // A game with no known date sorts by when it was imported, and shows no date.
      g.playedAt ?? iso(clock),
      g.playedAt ? 1 : 0,
      iso(clock),
    );
  return Number(info.lastInsertRowid);
}

export function importPgn(db: Db, clock: Clock, pgn: string, playerSide: Side | undefined): { game: GameSummary; duplicate: boolean } {
  let game: ParsedGame;
  try {
    game = parseSinglePgn(pgn);
  } catch (err) {
    if (err instanceof PgnImportError) throw new AppError('invalid-pgn', err.message);
    throw new AppError('invalid-pgn', 'That PGN could not be read. Check that it was copied in full.');
  }
  if (!game.finished) {
    throw new AppError(
      'invalid-pgn',
      'That game has no result. Add it after the last move (1-0, 0-1 or 1/2-1/2), then import it again. Only finished games can be imported.',
    );
  }
  const sourceId = movesHash(game.startFen, game.moves);
  const existing = findBySource(db, 'pgn', sourceId);
  if (existing) return { game: existing, duplicate: true };
  const side = playerSide ?? playersSide(db, game.headers);
  if (!side) throw new AppError('needs-side', 'Which side did you play in this game?');
  return insertGame(db, clock, {
    kind: 'imported',
    source: 'pgn',
    sourceId,
    pgn,
    game,
    playerSide: side,
    playedAt: headerDate(game.headers),
  });
}

/**
 * The Player's side in a game whose headers name them: by the Player Profile's username, or one
 * their games were fetched for. A game between two such names (a friend's games fetched too) is
 * the Player's to say.
 */
function playersSide(db: Db, headers: Record<string, string>): Side | undefined {
  const names = [getProfile(db).ratingSource?.username, ...all<{ username: string }>(db, 'SELECT DISTINCT username FROM site_imports').map((r) => r.username)];
  const sides = new Set(names.map((name) => sideOf(headers, name)).filter((side) => side !== undefined));
  return sides.size === 1 ? [...sides][0] : undefined;
}

/** Sets the Player's side in an Imported Game; an Engine Game's side is always known. */
export function setPlayerSide(db: Db, id: number, side: Side): GameSummary {
  if (gameRow(db, id).source === 'engine') throw new AppError('bad-request', 'The side you played in an Engine Game can’t be changed.');
  db.prepare('UPDATE games SET player_side = ? WHERE id = ?').run(side, id);
  return toSummary(gameRow(db, id));
}

/**
 * Deletes a game; its Review and graded moves go with it. A game from Lichess or chess.com is
 * remembered, so fetching that username again doesn't bring it back.
 */
export function deleteGame(db: Db, id: number): void {
  const { source, source_id } = gameRow(db, id);
  if (source === 'lichess' || source === 'chesscom') db.prepare('INSERT OR IGNORE INTO deleted_games (source, source_id) VALUES (?, ?)').run(source, source_id);
  db.prepare('DELETE FROM games WHERE id = ?').run(id);
}

/** Imports the sample game as its own source, so its Review never counts in the Player Profile; a second import finds it. */
export function importSample(db: Db, clock: Clock): { game: GameSummary; duplicate: boolean } {
  const game = parseSinglePgn(SAMPLE_GAME_PGN);
  return insertGame(db, clock, {
    kind: 'imported',
    source: 'sample',
    sourceId: movesHash(game.startFen, game.moves),
    pgn: SAMPLE_GAME_PGN,
    game,
    playerSide: SAMPLE_GAME_SIDE,
    playedAt: headerDate(game.headers),
  });
}

/** Imports one game fetched by username, unless it is already in the list or the Player deleted it. */
export function importSiteGame(
  db: Db,
  clock: Clock,
  source: 'lichess' | 'chesscom',
  sourceId: string,
  game: ParsedGame,
  username: string,
  pgn: string,
): 'imported' | 'duplicate' | 'deleted' {
  // A whole history can be thousands of games, so this neither rereads nor returns the game.
  if (one(db, 'SELECT 1 FROM games WHERE source = ? AND source_id = ?', source, sourceId)) return 'duplicate';
  if (one(db, 'SELECT 1 FROM deleted_games WHERE source = ? AND source_id = ?', source, sourceId)) return 'deleted';
  const side = sideOf(game.headers, username) ?? 'white';
  insertRow(db, clock, {
    kind: 'imported',
    source,
    sourceId,
    pgn,
    game,
    playerSide: side,
    playedAt: headerDate(game.headers) ?? iso(clock),
  });
  return 'imported';
}

/** How an import by username is stored: neither site tells two players apart by case. */
function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * The time (ms, as the site orders games) up to which every finished game of this username is
 * imported; 0 when it was never imported, so the next import fetches the whole history.
 */
export function importedThrough(db: Db, site: 'lichess' | 'chesscom', username: string): number {
  return one<{ imported_through: number }>(db, 'SELECT imported_through FROM site_imports WHERE site = ? AND username = ?', site, usernameKey(username))?.imported_through ?? 0;
}

/** Moves the point an import by username has reached forward, never back. */
export function setImportedThrough(db: Db, site: 'lichess' | 'chesscom', username: string, through: number): void {
  db.prepare(
    `INSERT INTO site_imports (site, username, imported_through) VALUES (?, ?, ?)
     ON CONFLICT(site, username) DO UPDATE SET imported_through = MAX(imported_through, excluded.imported_through)`,
  ).run(site, usernameKey(username), through);
}

/** Lichess games of this username that were still being played at the last import. */
export function playingGames(db: Db, site: 'lichess' | 'chesscom', username: string): string[] {
  return all<{ game_id: string }>(db, 'SELECT game_id FROM site_import_playing WHERE site = ? AND username = ? ORDER BY game_id', site, usernameKey(username)).map((r) => r.game_id);
}

/** Notes that a game is still being played, to ask for it again next time, or that it no longer is. */
export function setPlaying(db: Db, site: 'lichess' | 'chesscom', username: string, gameId: string, playing: boolean): void {
  if (playing) db.prepare('INSERT OR IGNORE INTO site_import_playing (site, username, game_id) VALUES (?, ?, ?)').run(site, usernameKey(username), gameId);
  else db.prepare('DELETE FROM site_import_playing WHERE site = ? AND username = ? AND game_id = ?').run(site, usernameKey(username), gameId);
}

export const ENGINE_NAME = (strength: number) => `Engine (${ENGINE_LEVEL_NAMES[strength] ?? `level ${strength}`})`;

export function saveEngineGame(db: Db, clock: Clock, record: EngineGameRecord): { game: GameSummary; duplicate: boolean } {
  if (!/^[\w-]{6,64}$/.test(record.clientId)) throw new AppError('bad-request', 'Engine Game id is not valid.');
  if (!['1-0', '0-1', '1/2-1/2'].includes(record.result)) {
    throw new AppError('bad-request', 'Only finished Engine Games are saved.');
  }
  const start = INITIAL_FEN;
  const played = playLine(start, record.moves);
  if (played.length !== record.moves.length) throw new AppError('bad-request', `Move ${played.length + 1} of that Engine Game is not legal.`);
  const engine = ENGINE_NAME(record.strength);
  const white = record.playerSide === 'white' ? 'You' : engine;
  const black = record.playerSide === 'black' ? 'You' : engine;
  const date = record.finishedAt.slice(0, 10).replace(/-/g, '.');
  const headers = {
    Event: 'Engine Game',
    Site: 'OpenChessCoach',
    Date: date,
    White: white,
    Black: black,
    Result: record.result,
    Termination: record.termination,
  };
  const pgn = makeSimplePgn(headers, played.map((m) => m.san), record.result);
  return insertGame(db, clock, {
    kind: 'engine',
    source: 'engine',
    sourceId: record.clientId,
    pgn,
    game: { headers, startFen: start, moves: played.map((m) => m.uci), sans: played.map((m) => m.san), result: record.result, finished: true },
    playerSide: record.playerSide,
    playedAt: record.finishedAt,
  });
}
