// One SQLite file in the owner's data folder is the single source of truth (ADR 0003).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const DB_FILE = 'coach.sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    onboarded INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'beginner',
    rating INTEGER,
    rating_site TEXT,
    rating_username TEXT,
    goals TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO profile (id) VALUES (1);
  CREATE TABLE coach_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE grade_counts (
    opening TEXT NOT NULL,
    grade TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (opening, grade)
  );
  CREATE TABLE games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('imported', 'engine')),
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    pgn TEXT NOT NULL,
    start_fen TEXT NOT NULL,
    moves TEXT NOT NULL,
    white TEXT NOT NULL,
    black TEXT NOT NULL,
    player_side TEXT NOT NULL,
    result TEXT NOT NULL,
    opening TEXT NOT NULL,
    played_at TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    UNIQUE (source, source_id)
  );
  CREATE TABLE graded_moves (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,
    side TEXT NOT NULL,
    uci TEXT NOT NULL,
    san TEXT NOT NULL,
    grade TEXT NOT NULL,
    win_loss REAL NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (game_id, ply)
  );
  CREATE TABLE reviews (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    moments TEXT NOT NULL
  );
  CREATE TABLE lesson_progress (
    lesson_id TEXT PRIMARY KEY,
    step INTEGER NOT NULL,
    completed INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE puzzle_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_id TEXT NOT NULL,
    opening TEXT NOT NULL,
    solved INTEGER NOT NULL,
    mistakes INTEGER NOT NULL,
    attempted_at TEXT NOT NULL
  );
  CREATE TABLE coach_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coach TEXT NOT NULL,
    job TEXT NOT NULL,
    model TEXT NOT NULL,
    brief TEXT NOT NULL,
    raw_reply TEXT,
    stripped TEXT,
    at TEXT NOT NULL
  );
  `,
  // A pasted PGN may not say when the game was played. Such games used to take the import time
  // as their date; mark the ones already imported as having no known date.
  `
  ALTER TABLE games ADD COLUMN date_known INTEGER NOT NULL DEFAULT 1;
  UPDATE games SET date_known = 0
   WHERE source = 'pgn'
     AND pgn NOT GLOB '*[[]Date "[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]"*'
     AND pgn NOT GLOB '*[[]UTCDate "[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]"*';
  `,
  // A PGN date that isn't a real day (such as 2020.02.30) used to be kept as the date; it is
  // unknown now, like a missing one. SQLite rolls such a day over, so it no longer matches itself.
  `
  UPDATE games SET date_known = 0, played_at = imported_at
   WHERE date_known = 1
     AND date(substr(played_at, 1, 10)) IS NOT substr(played_at, 1, 10);
  `,
  // How far each import by username has got, so the next one fetches only newer games. Usernames
  // are stored lowercase: neither site tells two players apart by case.
  `
  CREATE TABLE IF NOT EXISTS site_imports (
    site TEXT NOT NULL,
    username TEXT NOT NULL,
    imported_through INTEGER NOT NULL,
    PRIMARY KEY (site, username)
  );
  `,
  // Lichess games still being played at the last import by username: the import moves past them
  // and asks for each again by id, so a long correspondence game doesn't hold every import back.
  `
  CREATE TABLE IF NOT EXISTS site_import_playing (
    site TEXT NOT NULL,
    username TEXT NOT NULL,
    game_id TEXT NOT NULL,
    PRIMARY KEY (site, username, game_id)
  );
  `,
  // The game list comes a page at a time, newest first: an index keeps a page quick for a
  // Player with tens of thousands of games.
  `
  CREATE INDEX IF NOT EXISTS games_newest ON games (played_at DESC, id DESC);
  `,
  // Games from Lichess or chess.com the Player deleted: an import by username hands some games
  // over again (the newest, or a month with a game still being played), and none of these may
  // come back. A pasted PGN keeps no record, so pasting it again brings it back.
  `
  CREATE TABLE IF NOT EXISTS deleted_games (
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY (source, source_id)
  );
  `,
  // With Think deeper on, each question the Coach asked the Engine in a Coach call, and the
  // Engine's answer or why it was refused (ADR 0010).
  `
  CREATE TABLE IF NOT EXISTS coach_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    refused TEXT,
    ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS coach_questions_call ON coach_questions (call_id);
  `,
  // Where each Coach call's tempting moves came from (Maia-3, Opus or the fake), the moves, how
  // long the guess took and, for Opus, what it cost (ADR 0011). A job that gets none has no row.
  `
  CREATE TABLE IF NOT EXISTS coach_tempting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    moves TEXT NOT NULL,
    ms INTEGER NOT NULL,
    usage TEXT
  );
  CREATE INDEX IF NOT EXISTS coach_tempting_call ON coach_tempting (call_id);
  `,
  // Which pool the Player Profile's rating is from, and the Player's blitz rating on that site, so
  // Maia-3 gets a rating on the scale it learned (ADR 0011). One row, like the profile.
  `
  CREATE TABLE IF NOT EXISTS rating_pools (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pool TEXT,
    blitz INTEGER
  );
  `,
  // A Review's overview of the whole game (its text and the moves it names), as JSON. Reviews saved
  // before there was one, or made with it turned off in Settings, have none.
  `
  ALTER TABLE reviews ADD COLUMN overview TEXT;
  `,
];

/** Tables `coachctl db get` may read. */
export const READABLE_TABLES = [
  'meta',
  'devices',
  'settings',
  'profile',
  'coach_notes',
  'grade_counts',
  'games',
  'site_imports',
  'site_import_playing',
  'deleted_games',
  'graded_moves',
  'reviews',
  'lesson_progress',
  'puzzle_attempts',
  'coach_calls',
  'coach_questions',
  'coach_tempting',
  'rating_pools',
] as const;

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
