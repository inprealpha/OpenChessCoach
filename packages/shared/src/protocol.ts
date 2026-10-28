// The one protocol every client speaks to the backend: typed JSON over a WebSocket.
// A future GNOME client uses exactly these messages.
import type { Candidate, GradedMove } from './analysis.ts';
import type { Side } from './chess.ts';
import type { CoachReply, CoachRequest } from './coach/types.ts';
import type { Analysis } from './engine.ts';
import type { MoveGrade } from './grader.ts';
import type { Threat } from './threat.ts';

/** Raised whenever a message changes shape, so a client running older code is told to reload. */
export const PROTOCOL_VERSION = 3;

// ---------- Domain types ----------

export const PLAYER_LEVELS = ['beginner', 'casual', 'club'] as const;
export type PlayerLevel = (typeof PLAYER_LEVELS)[number];

export type RatingSite = 'lichess' | 'chesscom';

export interface CoachNote {
  id: number;
  text: string;
  createdAt: string;
}

export interface LessonProgress {
  lessonId: string;
  /** Number of Player decisions completed along the main line. */
  step: number;
  completed: boolean;
  updatedAt: string;
}

export interface PuzzleStats {
  attempted: number;
  solved: number;
}

export type GradeCounts = Partial<Record<MoveGrade, number>>;

export interface PlayerProfile {
  /** False until the first-run screen is finished or skipped. */
  onboarded: boolean;
  level: PlayerLevel;
  rating: number | null;
  ratingSource: { site: RatingSite; username: string } | null;
  goals: string[];
  /** Openings and themes where the Player's moves grade well, derived from the facts. */
  strengths: string[];
  /** Openings and themes where the Player's moves grade badly, derived from the facts. */
  weaknesses: string[];
  lessons: LessonProgress[];
  puzzles: PuzzleStats;
  /** Move Grade counts per opening, from Reviews. */
  gradeCounts: Record<string, GradeCounts>;
  notes: CoachNote[];
}

/** Where a game came from; `sample` is the app's sample game, which never counts in the Player Profile. */
export type GameSource = 'pgn' | 'lichess' | 'chesscom' | 'engine' | 'sample';

export interface GameSummary {
  id: number;
  source: GameSource;
  sourceId: string;
  white: string;
  black: string;
  playerSide: Side;
  opponent: string;
  result: string;
  opening: string;
  /** When the game was played; null when its PGN doesn't say. */
  date: string | null;
  hasReview: boolean;
}

/** How many games the game list sends at a time, newest first. */
export const GAMES_PAGE_SIZE = 50;
/** The most games one game list request may ask for, so a refresh of what is shown stays one request. */
export const GAMES_LIST_MAX = 500;

export interface GameDetail extends GameSummary {
  pgn: string;
  /** Moves in UCI from the starting position. */
  moves: string[];
  startFen: string;
}

export interface KeyMoment {
  ply: number;
  san: string;
  uci: string;
  grade: MoveGrade;
  fenBefore: string;
  /** The Engine's better options, best first, in SAN. */
  betterOptions: { uci: string; san: string; score: string }[];
  explanation: string;
  arrows: CoachReply['arrows'];
}

export interface Review {
  gameId: number;
  createdAt: string;
  moments: KeyMoment[];
  /** Graded moves for the whole game, so rereading needs no Engine run. */
  moves: GradedMove[];
}

/**
 * The longest Why Question (or typed Lesson answer) the desktop accepts, in characters. It fits the
 * brief whole: the brief keeps up to 400 characters of a question inside its budget (ADR 0004).
 */
export const MAX_QUESTION_LENGTH = 300;

export type CoachJob = 'review-moment' | 'why' | 'lesson-turn' | 'hint' | 'live';
export const COACH_JOBS: readonly CoachJob[] = ['review-moment', 'why', 'lesson-turn', 'hint', 'live'];

/** A Coach quality preset: one choice that sets the model of every Coach job. */
export type CoachQuality = 'thrifty' | 'balanced' | 'best';
export const COACH_QUALITIES: readonly CoachQuality[] = ['thrifty', 'balanced', 'best'];

export interface Settings {
  /** Model per Coach job, passed to the Claude Agent SDK. */
  models: Record<CoachJob, string>;
  /** The preset the per-job models match, or custom when they match none. Read from `models`, never stored. */
  quality: CoachQuality | 'custom';
  liveCoachingDefault: boolean;
  tunnelEnabled: boolean;
}

/**
 * A change to the settings: only the fields and Coach jobs named are changed. A `quality` writes that
 * preset's model for every Coach job; `models` named in the same change apply on top of it.
 */
export type SettingsPatch = Partial<Omit<Settings, 'models' | 'quality'>> & {
  models?: Partial<Record<CoachJob, string>>;
  quality?: CoachQuality;
};

export type CoachState = 'ready' | 'unavailable' | 'limit-reached';

export interface CoachStatus {
  state: CoachState;
  /** Plain-language reason when the Coach can't be used. */
  reason?: string;
}

export interface TunnelState {
  enabled: boolean;
  status: 'off' | 'starting' | 'running' | 'error';
  url: string | null;
  error?: string;
}

export interface PairingInfo {
  /** Address of this install on the local network. */
  lanUrl: string;
  /** URL that pairs a device when opened, also shown as a QR code. */
  pairUrl: string;
  /** The same URL as an SVG QR code. */
  qrSvg: string;
  tunnel: TunnelState;
  tunnelPairUrl: string | null;
  tunnelQrSvg: string | null;
  phone: PhoneStatus;
}

/** Whether the Player has a phone or tablet paired, and whether a desktop browser should ask them to pair one. */
export interface PhoneStatus {
  /** A phone or tablet is paired and not revoked. */
  paired: boolean;
  /** No phone is paired, and the Player hasn't said "later" (or that time has passed) or "don't ask again". */
  remind: boolean;
}

/** The Engine's strength levels in an Engine Game, by `EngineGameRecord.strength`. */
export const ENGINE_LEVEL_NAMES: Record<number, string> = { 1: 'Beginner', 2: 'Casual', 3: 'Club', 4: 'Strong' };

/** An Engine Game as the client records it. */
export interface EngineGameRecord {
  /** Client-generated id, so a game synced twice is saved once. */
  clientId: string;
  playerSide: Side;
  /** A key of `ENGINE_LEVEL_NAMES`. */
  strength: number;
  moves: string[];
  result: '1-0' | '0-1' | '1/2-1/2';
  /** How it ended: checkmate, resignation, draw agreed, stalemate, ... */
  termination: string;
  startedAt: string;
  finishedAt: string;
}

// ---------- Requests ----------

export interface RequestMap {
  /** `deviceName`, from the web app, renames this device: the name it paired under may predate today's naming. */
  hello: { req: { client: string; deviceName?: string }; res: { protocol: number; version: string; verify: boolean; deviceId: string; coach: CoachStatus } };
  'pairing.info': { req: Record<string, never>; res: PairingInfo };
  /** Revokes every device token and the pairing code. The caller gets a fresh token so it stays paired. */
  'pairing.reset': { req: Record<string, never>; res: { token: string } };
  /** The Player put off pairing a phone: ask again in a few days, or with `never`, not again. */
  'pairing.remindLater': { req: { never?: boolean }; res: PhoneStatus };

  'profile.get': { req: Record<string, never>; res: PlayerProfile };
  'profile.update': {
    req: { level?: PlayerLevel; goals?: string[]; onboarded?: boolean; rating?: { site: RatingSite; username: string } | null };
    res: PlayerProfile;
  };
  'profile.deleteNote': { req: { noteId: number }; res: PlayerProfile };

  'games.importPgn': { req: { pgn: string; playerSide?: Side }; res: { game: GameSummary; duplicate: boolean } };
  /** Imports the sample game, for a Player with no games yet to try a Review on; once only. */
  'games.importSample': { req: Record<string, never>; res: { game: GameSummary; duplicate: boolean } };
  /**
   * Imports a username's finished games: the whole history the first time, then only newer games
   * (sending progress as games arrive, with total 0 as the count isn't known up front).
   */
  'games.importUser': {
    req: { site: RatingSite; username: string };
    /** Counts: a whole history can be tens of thousands of games, and the list is reread anyway. */
    res: { imported: number; duplicates: number; skippedUnfinished: number; unreadable: number };
  };
  /**
   * A page of the game list, newest first: `limit` games (GAMES_PAGE_SIZE unless asked, at most
   * GAMES_LIST_MAX) after skipping `offset`, with the total number of games.
   */
  'games.list': { req: { offset?: number; limit?: number }; res: { games: GameSummary[]; total: number } };
  'games.get': { req: { gameId: number }; res: GameDetail };
  /**
   * Sets which side the Player had in an Imported Game. A Review of the other side's moves no
   * longer applies, so it is dropped, with the Move Grades it counted into the Player Profile.
   * A game with a Review is refused with `needs-confirm` unless `dropReview` says the Player
   * agreed that it goes: a list loaded before another device made the Review doesn't know.
   */
  'games.setSide': { req: { gameId: number; playerSide: Side; dropReview?: boolean }; res: GameSummary };
  /** Deletes a game with its Review and the Move Grades that Review counted; gives the games left. */
  'games.delete': { req: { gameId: number }; res: { total: number } };
  'games.saveEngineGame': { req: { game: EngineGameRecord }; res: { game: GameSummary; duplicate: boolean } };
  'games.syncOffline': { req: { games: EngineGameRecord[] }; res: { saved: GameSummary[]; duplicates: number } };

  /**
   * Grades every move on the desktop's Engine (sending progress), picks the key moments and
   * streams the Coach's explanation of each (ADR 0007).
   */
  'review.start': { req: { gameId: number }; res: Review };
  /** The saved Review, if any; `beingMade` when the desktop is making it right now, for whichever request asked. */
  'review.get': { req: { gameId: number }; res: { review: Review | null; beingMade: boolean } };

  'lessons.progress': { req: Record<string, never>; res: { lessons: LessonProgress[] } };
  'lessons.update': { req: { lessonId: string; step: number; completed: boolean }; res: LessonProgress };

  'puzzles.record': { req: { puzzleId: string; opening: string; solved: boolean; mistakes: number }; res: PuzzleStats };

  /** The desktop Engine's facts for the request, then coach.delta messages, then the guarded reply. */
  'coach.ask': { req: CoachRequest; res: CoachReply };

  /** The desktop Engine's top lines in a position, for clients without their own Engine. */
  'engine.analyse': { req: { fen: string }; res: Analysis };
  /** The desktop Engine's Move Grade for one move, with its candidates and the replies to it. */
  'engine.grade': { req: { fen: string; uci: string; ply?: number }; res: { move: GradedMove; replies: Candidate[] } };
  /** The desktop Engine's threat in a position (the opponent's best move if they could move now), or null when there is none worth showing. */
  'engine.threat': { req: { fen: string }; res: { threat: Threat | null } };

  'settings.get': { req: Record<string, never>; res: Settings };
  'settings.update': { req: SettingsPatch; res: Settings };
}

export type RequestType = keyof RequestMap;
export type RequestBody<K extends RequestType> = RequestMap[K]['req'];
export type ResponseBody<K extends RequestType> = RequestMap[K]['res'];

export type ClientMessage = {
  [K in RequestType]: { v: number; id: string; type: K } & RequestBody<K>;
}[RequestType];

// ---------- Server messages ----------

export type ErrorCode =
  | 'bad-request'
  | 'unknown-type'
  | 'version-mismatch'
  | 'not-found'
  | 'invalid-pgn'
  | 'needs-side'
  /** A change that would drop something the Player hasn't agreed to lose, such as a game's Review. */
  | 'needs-confirm'
  | 'unknown-user'
  | 'rate-limited'
  | 'site-unreachable'
  | 'coach-unavailable'
  | 'coach-limit'
  | 'coach-error'
  | 'brief-too-large'
  | 'engine-unavailable'
  /** The request was stopped before it finished, for example a Review whose connection closed. */
  | 'cancelled'
  | 'internal';

export type ServerMessage =
  | { v: number; id: string; type: 'result'; ok: true; data: unknown }
  | { v: number; id: string; type: 'error'; ok: false; code: ErrorCode; message: string }
  /** A chunk of Coach text for request `id`. `part` separates the moments of a Review. */
  | { v: number; id: string; type: 'coach.delta'; text: string; part?: number }
  /**
   * How far the desktop has got with request `id`, for example grading a game for a Review or
   * fetching games by username. A total of 0 means the total isn't known yet.
   */
  | { v: number; id: string; type: 'progress'; done: number; total: number }
  | { v: number; type: 'event'; event: ServerEvent };

export type ServerEvent =
  | { kind: 'coach-status'; status: CoachStatus }
  | { kind: 'tunnel'; tunnel: TunnelState }
  | { kind: 'pairing-reset' }
  /** A device paired: whether a phone is now paired, so a screen showing the QR code says so without fetching it again. */
  | { kind: 'device-paired'; phone: PhoneStatus };

export function isClientMessage(value: unknown): value is { v: number; id: string; type: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.v === 'number' && typeof v.id === 'string' && typeof v.type === 'string';
}

/** WebSocket close code sent when a token is refused after the upgrade. */
export const CLOSE_UNAUTHORISED = 4401;
