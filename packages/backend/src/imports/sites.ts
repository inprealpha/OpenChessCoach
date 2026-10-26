// Lichess and chess.com public APIs, by username. Only finished games are ever imported, so the
// app can never be used to look at a game that is still being played.
import { parsePgnGames, type ParsedGame } from '@chess-coach/shared/pgn';
import type { RatingSite } from '@chess-coach/shared/protocol';
import { AppError } from '../errors.ts';
import { headerDate } from '../games.ts';

export const LICHESS = 'https://lichess.org';
export const CHESSCOM = 'https://api.chess.com';
// Both sites ask API users to say who they are and how to reach them.
const USER_AGENT = 'OpenChessCoach (a personal chess learning app; one request at a time; https://github.com/inprealpha/OpenChessCoach)';
/** How long a site may go quiet, before answering or in the middle of an answer, before the app gives up. */
export const SITE_TIMEOUT_MS = 30_000;
/** Lichess games handed over per batch while its export streams in. */
const LICHESS_BATCH = 100;

export interface SiteGame {
  site: RatingSite;
  sourceId: string;
  game: ParsedGame;
  /** False for a game still being played; it must be fetched again once it is over. */
  finished: boolean;
  /** The time the site orders this game by, in ms: when it started on Lichess, when it ended on chess.com. */
  time: number;
}

/**
 * Hands over a batch of games as they arrive, with how many in that stretch couldn't be read.
 * Games that never became a game (aborted, never started) and variants aren't handed over.
 * `rechecked` lists the Lichess games asked for again by id in this batch: those not handed over
 * as still being played are no longer waited for.
 */
export type OnBatch = (games: SiteGame[], unreadable: number, rechecked: string[]) => void;

export interface SiteOptions {
  fetch: typeof fetch;
  /** Stops the import, for example when the Player's connection closes. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

const SITE_NAME: Record<RatingSite, string> = { lichess: 'Lichess', chesscom: 'chess.com' };

/** An error from the caller's own code while an answer streams in, passed on untouched. */
class CallerError extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super('The caller failed while reading a site');
    this.inner = inner;
  }
}

/** Lichess wants one request at a time, so every Lichess call goes through this queue. */
let lichessQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = lichessQueue.then(fn, fn);
  lichessQueue = next.catch(() => undefined);
  return next;
}

/** Sites with an import by username running; one at a time per site, as each limits parallel requests. */
const importing = new Set<RatingSite>();

function cleanUsername(username: string): string {
  const u = username.trim();
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(u)) throw new AppError('bad-request', 'Usernames only use letters, numbers, - and _.');
  return u;
}

/**
 * Asks a site for `url` and reads the answer with `read`, which calls `alive` whenever more of the
 * answer arrives. Gives up when the site goes quiet for the timeout, and turns every failure into
 * an error written for the Player.
 */
async function request<T>(
  opts: SiteOptions,
  site: RatingSite,
  url: string,
  username: string,
  accept: string,
  read: (res: Response, alive: () => void) => Promise<T>,
  body?: string,
): Promise<T> {
  const name = SITE_NAME[site];
  const abort = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, opts.timeoutMs ?? SITE_TIMEOUT_MS);
  };
  const stop = () => abort.abort();
  if (opts.signal?.aborted) abort.abort();
  else opts.signal?.addEventListener('abort', stop, { once: true });
  alive();
  try {
    let res: Response;
    try {
      res = await opts.fetch(
        url,
        body === undefined
          ? { headers: { accept, 'user-agent': USER_AGENT }, signal: abort.signal }
          : { method: 'POST', body, headers: { accept, 'content-type': 'text/plain', 'user-agent': USER_AGENT }, signal: abort.signal },
      );
    } catch (err) {
      if (abort.signal.aborted) throw err;
      throw new AppError('site-unreachable', `Couldn't reach ${name}. Check the desktop's internet connection and try again.`);
    }
    if (res.status === 404) throw new AppError('unknown-user', `${name} has no player called "${username}". Check the spelling.`);
    if (res.status === 429) throw new AppError('rate-limited', `${name} is limiting requests right now. Wait a minute and try again.`);
    if (!res.ok) throw new AppError('site-unreachable', `${name} answered with an error (${res.status}). Try again later.`);
    return await read(res, alive);
  } catch (err) {
    if (err instanceof CallerError) throw err.inner;
    if (opts.signal?.aborted) throw new AppError('cancelled', 'The import was stopped.');
    if (timedOut) throw new AppError('site-unreachable', `${name} stopped answering. Try again later.`);
    if (err instanceof AppError) throw err;
    if (err instanceof SyntaxError) throw new AppError('site-unreachable', `${name} sent an answer the app couldn’t read. Try again later.`);
    throw new AppError('site-unreachable', `The connection to ${name} broke off. Try again.`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
    // Closes an answer that wasn't read to the end, so no request outlives its turn.
    abort.abort();
  }
}

/** Reads an answer as text as it arrives, calling `alive` for every piece. */
async function readChunks(res: Response, alive: () => void, onText: (text: string) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) {
    onText(await res.text());
    return;
  }
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    alive();
    onText(decoder.decode(value, { stream: !done }));
    if (done) return;
  }
}

async function readJson<T>(res: Response, alive: () => void): Promise<T> {
  let text = '';
  await readChunks(res, alive, (t) => (text += t));
  return JSON.parse(text) as T;
}

/** The Player's rating on `site`; `signal` stops the lookup, for example when the Player's connection closes. */
export async function fetchRating(fetchImpl: typeof fetch, site: RatingSite, username: string, signal?: AbortSignal): Promise<number> {
  const u = cleanUsername(username);
  const opts: SiteOptions = { fetch: fetchImpl, ...(signal ? { signal } : {}) };
  // Neither site wants parallel requests, and an import can run for minutes.
  if (importing.has(site)) throw new AppError('rate-limited', `Games are being fetched from ${SITE_NAME[site]} right now. Try again once that’s done.`);
  if (site === 'lichess') {
    return oneAtATime(async () => {
      type User = { perfs?: Record<string, { rating?: number; games?: number }>; disabled?: boolean };
      const data = await request(opts, site, `${LICHESS}/api/user/${encodeURIComponent(u)}`, u, 'application/json', readJson<User>);
      if (data.disabled) throw new AppError('unknown-user', `The Lichess account "${u}" is closed.`);
      const perfs = data.perfs ?? {};
      for (const key of ['rapid', 'classical', 'blitz', 'bullet', 'correspondence']) {
        const p = perfs[key];
        if (p?.rating && (p.games ?? 0) > 0) return p.rating;
      }
      return perfs.rapid?.rating ?? 1500;
    });
  }
  type Stats = Record<string, { last?: { rating?: number } } | undefined>;
  const data = await request(opts, site, `${CHESSCOM}/pub/player/${encodeURIComponent(u.toLowerCase())}/stats`, u, 'application/json', readJson<Stats>);
  for (const key of ['chess_rapid', 'chess_daily', 'chess_blitz', 'chess_bullet']) {
    const r = data[key]?.last?.rating;
    if (r) return r;
  }
  throw new AppError('unknown-user', `"${u}" has no rated games on chess.com yet.`);
}

/**
 * Every game a username played since `since` (ms; 0 for their whole history), oldest first,
 * handed to `onBatch` as it arrives so a long history is saved as it goes. On Lichess, the games
 * in `playing` (still being played at the last import) are then asked for again by id.
 */
export async function fetchGamesSince(
  opts: SiteOptions,
  site: RatingSite,
  username: string,
  since: number,
  onBatch: OnBatch,
  playing: readonly string[] = [],
): Promise<void> {
  const u = cleanUsername(username);
  // Per site, not per username: the site limits this desktop's requests, whoever they are for.
  if (importing.has(site)) throw new AppError('rate-limited', `Games are already being fetched from ${SITE_NAME[site]}. Wait for that to finish.`);
  importing.add(site);
  try {
    await (site === 'lichess' ? lichessGames(opts, u, since, playing, onBatch) : chesscomGames(opts, u, since, onBatch));
  } finally {
    importing.delete(site);
  }
}

function parseOne(pgn: string | undefined): ParsedGame | undefined {
  if (!pgn) return undefined;
  try {
    return parsePgnGames(pgn)[0];
  } catch {
    return undefined;
  }
}

/** Lichess statuses of a game still being played. */
const LICHESS_PLAYING = new Set(['created', 'started']);
/** Lichess statuses of a game that never became one: it was aborted or never started. */
const LICHESS_VOID = new Set(['aborted', 'noStart', 'unknownFinish']);
/** Lichess hands over at most this many games per request by id. */
const LICHESS_IDS_MAX = 300;

async function lichessGames(opts: SiteOptions, username: string, since: number, playing: readonly string[], onBatch: OnBatch): Promise<void> {
  const shape = { pgnInJson: 'true', opening: 'true', clocks: 'false', evals: 'false' };
  const params = new URLSearchParams({
    // Games still being played come too: Lichess picks games by when they started, so the import
    // moves past them and asks for each again by id next time.
    ongoing: 'true',
    finished: 'true',
    sort: 'dateAsc',
    ...shape,
    perfType: 'ultraBullet,bullet,blitz,rapid,classical,correspondence',
  });
  if (since > 0) params.set('since', String(since));
  const url = `${LICHESS}/api/games/user/${encodeURIComponent(username)}?${params}`;
  const handed = new Set<string>();
  /** Reads an export answer, one game per line, handing over a batch every LICHESS_BATCH games (a recheck all at once). */
  const readExport = (rechecked: string[]) => async (res: Response, alive: () => void) => {
    let batch: SiteGame[] = [];
    let unreadable = 0;
    const hand = () => {
      try {
        onBatch(batch, unreadable, rechecked);
      } catch (err) {
        throw new CallerError(err);
      }
      batch = [];
      unreadable = 0;
    };
    const line = (text: string) => {
      if (!text.trim()) return;
      const g = JSON.parse(text) as { id: string; status?: string; variant?: string; pgn?: string; createdAt?: number };
      if ((g.variant && g.variant !== 'standard') || LICHESS_VOID.has(g.status ?? '')) return;
      const parsed = parseOne(g.pgn);
      const ongoing = LICHESS_PLAYING.has(g.status ?? 'started');
      // A game Lichess calls over must have moves that end in a result.
      if (!parsed || (!ongoing && !parsed.finished)) {
        unreadable++;
        return;
      }
      const time = g.createdAt ?? Date.parse(headerDate(parsed.headers) ?? '');
      handed.add(g.id);
      batch.push({ site: 'lichess', sourceId: g.id, game: parsed, finished: !ongoing, time: Number.isFinite(time) ? time : 0 });
      // A recheck is handed over in one batch, so what it settles is saved together.
      if (!rechecked.length && batch.length >= LICHESS_BATCH) hand();
    };
    // The export streams one game per line; a long history takes minutes, so read it as it comes.
    let rest = '';
    await readChunks(res, alive, (text) => {
      const lines = (rest + text).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) line(l);
    });
    line(rest);
    if (batch.length || unreadable || rechecked.length) hand();
  };
  await oneAtATime(async () => {
    await request(opts, 'lichess', url, username, 'application/x-ndjson', readExport([]));
    // Games that were still being played last time and didn't come again: asked for by id.
    const recheck = playing.filter((id) => !handed.has(id));
    const idParams = new URLSearchParams(shape);
    for (let i = 0; i < recheck.length; i += LICHESS_IDS_MAX) {
      const ids = recheck.slice(i, i + LICHESS_IDS_MAX);
      await request(opts, 'lichess', `${LICHESS}/api/games/export/_ids?${idParams}`, username, 'application/x-ndjson', readExport(ids), ids.join(','));
    }
  });
}

/** A monthly archive's address ends in /YYYY/MM; '' for anything else. */
function archiveMonth(url: string): string {
  return url.match(/\/(\d{4})\/(\d{2})$/)?.slice(1, 3).join('/') ?? '';
}

async function chesscomGames(opts: SiteOptions, username: string, since: number, onBatch: OnBatch): Promise<void> {
  const base = `${CHESSCOM}/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const { archives = [] } = await request(opts, 'chesscom', `${base}/games/archives`, username, 'application/json', readJson<{ archives?: string[] }>);
  const all = archives.filter((a) => a.startsWith(`${CHESSCOM}/`) && archiveMonth(a)).sort((a, b) => archiveMonth(a).localeCompare(archiveMonth(b)));
  const newest = all.at(-1);
  // chess.com files each game under the month it ended, so the month of `since` still has to be read.
  const from = since > 0 ? new Date(since).toISOString().slice(0, 7).replace('-', '/') : '';
  // One month at a time: chess.com limits parallel requests, not requests in a row.
  for (const archive of all.filter((a) => archiveMonth(a) >= from)) {
    type Month = { games?: { url: string; uuid?: string; pgn?: string; rules?: string; end_time?: number }[] };
    const { games = [] } = await request(opts, 'chesscom', archive, username, 'application/json', readJson<Month>);
    const [year, month] = archiveMonth(archive).split('/').map(Number) as [number, number];
    // A game with no end time isn't over; it counts as played when its month began. Only the
    // newest month can hold one: anywhere else it is a game that never finished and never will.
    const timeOf = (g: { end_time?: number }) => (g.end_time ? g.end_time * 1000 : Date.UTC(year, month - 1, 1));
    const batch: SiteGame[] = [];
    let unreadable = 0;
    for (const g of [...games].sort((a, b) => timeOf(a) - timeOf(b))) {
      if (g.rules && g.rules !== 'chess') continue;
      if (!g.end_time && archive !== newest) continue;
      const time = timeOf(g);
      const finished = Boolean(g.end_time);
      // A game still being played is always handed over, so it is counted as skipped.
      if (finished && time < since) continue;
      const parsed = parseOne(g.pgn);
      // A game that ended must have moves that end in a result.
      if (!parsed || (finished && !parsed.finished)) {
        unreadable++;
        continue;
      }
      batch.push({ site: 'chesscom', sourceId: g.uuid ?? g.url, game: parsed, finished, time });
    }
    if (batch.length || unreadable) onBatch(batch, unreadable, []);
  }
}
