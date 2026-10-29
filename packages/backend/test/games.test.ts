// Imports, Reviews and Engine Games through the protocol seam.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import WebSocket from 'ws';
import { gradeGame } from '@chess-coach/shared/analysis';
import { INITIAL_FEN } from '@chess-coach/shared/chess';
import { BRIEF_BUDGET, type Brief } from '@chess-coach/shared/coach/brief';
import { GAMES_PAGE_SIZE, PROTOCOL_VERSION, type EngineGameRecord, type ReviewPart } from '@chess-coach/shared/protocol';
import { FakeClock } from '../src/clock.ts';
import { openDb } from '../src/db.ts';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { listGames } from '../src/games.ts';
import { getReview, reviewInProgress } from '../src/reviews.ts';
import { CHESSCOM, fetchGamesSince } from '../src/imports/sites.ts';
import { recordedFetch } from '../src/verify/recorded-sites.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';
import { seed, SEED_GAME_PGN } from '../src/verify/seed.ts';
import { client, instance, rows } from './helpers.ts';

/** A finished client frame (1 text, 8 close), masked as clients must, with a zero key so the payload reads as sent. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length >= 126) throw new Error('Keep test frames under 126 bytes');
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), Buffer.alloc(4), payload]);
}

const PGNS = readFileSync(new URL('../../shared/test/fixtures/lichess-games.pgn', import.meta.url), 'utf8').trim().split(/\n\n(?=\[Event )/);

describe('importing by username', () => {
  it('imports Lichess games from the recorded API response, never one still being played', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const r = await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    expect(r).toMatchObject({ duplicates: 0, skippedUnfinished: 1 });
    expect(r).toMatchObject({ imported: 3, unreadable: 0 });
    expect(rows<{ source_id: string }>(app, "SELECT source_id FROM games WHERE source = 'lichess'").map((g) => g.source_id).sort()).toEqual(['iinnkv77', 'wab4h6cl', 'wvkkfh56']);
    expect(rows(app, "SELECT * FROM games WHERE source_id = 'livegame1'")).toHaveLength(0);
    // The Player's side comes from the username.
    expect(rows(app, "SELECT player_side FROM games WHERE source_id = 'wvkkfh56'")).toEqual([{ player_side: 'black' }]);
    const again = await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    expect(again).toMatchObject({ imported: 0, duplicates: 3, skippedUnfinished: 1 });
  });

  it('imports chess.com games from the monthly archives, never one still being played', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const r = await c.request('games.importUser', { site: 'chesscom', username: 'CoachVerify' });
    expect(r).toMatchObject({ imported: 3, skippedUnfinished: 1 });
    expect(rows<{ source: string }>(app, 'SELECT source FROM games').every((g) => g.source === 'chesscom')).toBe(true);
  });

  it('gives a clear error for an unknown username, rate limiting and an unreachable site', async () => {
    const app = await instance();
    const c = await client(app);
    await expect(c.request('games.importUser', { site: 'lichess', username: 'NoSuchPlayer' })).rejects.toMatchObject({
      code: 'unknown-user',
      message: 'Lichess has no player called "NoSuchPlayer". Check the spelling.',
    });
    await expect(c.request('games.importUser', { site: 'chesscom', username: 'NoSuchPlayer' })).rejects.toMatchObject({ code: 'unknown-user' });
    await expect(c.request('games.importUser', { site: 'lichess', username: 'BusyPlayer' })).rejects.toMatchObject({
      code: 'rate-limited',
      message: 'Lichess is limiting requests right now. Wait a minute and try again.',
    });
    await expect(c.request('games.importUser', { site: 'lichess', username: 'Unrecorded' })).rejects.toMatchObject({ code: 'site-unreachable' });
    await expect(c.request('games.importUser', { site: 'lichess', username: 'bad name!' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('asks Lichess one request at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const base = recordedFetch();
    const slow: typeof fetch = async (input, init) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await base(input, init);
      } finally {
        inFlight--;
      }
    };
    const app = await instance({ fetch: slow });
    const c = await client(app);
    const rating = c.request('profile.update', { rating: { site: 'lichess', username: 'CoachVerify' } as never });
    const results = await Promise.allSettled([
      rating,
      c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' }),
      c.request('profile.update', { rating: { site: 'lichess', username: 'CoachVerify' } as never }),
      c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' }),
    ]);
    expect(most).toBe(1);
    // While an import streams, the Player is told to wait rather than left queued behind it.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected']);
    expect(results.slice(2).map((r) => (r as PromiseRejectedResult).reason.message)).toEqual([
      'Games are being fetched from Lichess right now. Try again once that’s done.',
      'Games are already being fetched from Lichess. Wait for that to finish.',
    ]);
  });

  it('fetches the whole Lichess history oldest first, then only games since the last import', async () => {
    const asked: URL[] = [];
    const base = recordedFetch();
    const logged: typeof fetch = async (input, init) => {
      asked.push(new URL(String(input)));
      return base(input, init);
    };
    const app = await instance({ seed: 'empty', fetch: logged });
    const c = await client(app);
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    const first = asked.at(-1) as URL;
    expect(first.searchParams.get('sort')).toBe('dateAsc');
    // Games still being played come too, so each is noted and asked for again by id next time.
    expect(first.searchParams.get('ongoing')).toBe('true');
    expect(first.searchParams.has('max')).toBe(false);
    expect(first.searchParams.has('since')).toBe(false);
    // The newest game, still being played, started at 01:35:46; the import moves past it.
    const through = Date.parse('2013-01-01T01:35:46Z');
    expect(rows(app, 'SELECT * FROM site_imports')).toEqual([{ site: 'lichess', username: 'coachverify', imported_through: through }]);
    expect(rows(app, 'SELECT * FROM site_import_playing')).toEqual([{ site: 'lichess', username: 'coachverify', game_id: 'livegame1' }]);

    await c.request('games.importUser', { site: 'lichess', username: ' CoachVerify' });
    expect((asked.at(-1) as URL).searchParams.get('since')).toBe(String(through));
  });

  it('fetches every chess.com month the first time, then only from the month it reached', async () => {
    const asked: string[] = [];
    const august = `${CHESSCOM}/pub/player/coachverify/games/2026/08`;
    const base = recordedFetch({
      [`${CHESSCOM}/pub/player/coachverify/games/archives`]: {
        status: 200,
        body: { archives: [`${CHESSCOM}/pub/player/coachverify/games/2026/09`, `${CHESSCOM}/pub/player/coachverify/games/2026/10`, august] },
      },
      [august]: {
        status: 200,
        body: {
          games: [
            { url: 'https://www.chess.com/game/live/80000000', uuid: 'august-game', pgn: PGNS[4], rules: 'chess', end_time: 1787000000 },
            // No end time in an old month: a game that never finished, not one still being played.
            { url: 'https://www.chess.com/game/daily/80000001', uuid: 'never-ended', pgn: PGNS[5], rules: 'chess' },
          ],
        },
      },
    });
    const logged: typeof fetch = async (input, init) => {
      asked.push(String(input).replace(`${CHESSCOM}/pub/player/coachverify/games/`, ''));
      return base(input, init);
    };
    const app = await instance({ seed: 'empty', fetch: logged });
    const c = await client(app);
    const counts: [number, number][] = [];
    const r = await c.request('games.importUser', { site: 'chesscom', username: 'CoachVerify' }, undefined, (done, total) => counts.push([done, total]));
    expect(asked).toEqual(['archives', '2026/08', '2026/09', '2026/10']);
    // A running count of the games received, one month at a time; the total isn't known up front.
    expect(counts).toEqual([[1, 0], [3, 0], [5, 0]]);
    expect(r).toMatchObject({ duplicates: 0, skippedUnfinished: 1 });
    expect(r.imported).toBe(4);

    asked.length = 0;
    const again = await c.request('games.importUser', { site: 'chesscom', username: 'CoachVerify' });
    // The newest finished game ended in September's archive, so August isn't read again.
    expect(asked).toEqual(['archives', '2026/09', '2026/10']);
    expect(again).toMatchObject({ imported: 0, duplicates: 1, skippedUnfinished: 1 });
  });

  it('keeps the games fetched before a failure, and the next import carries on from there', async () => {
    const august = `${CHESSCOM}/pub/player/coachverify/games/2026/08`;
    const base = recordedFetch({
      [`${CHESSCOM}/pub/player/coachverify/games/archives`]: {
        status: 200,
        body: { archives: [august, `${CHESSCOM}/pub/player/coachverify/games/2026/09`, `${CHESSCOM}/pub/player/coachverify/games/2026/10`] },
      },
      [august]: { status: 200, body: { games: [{ url: 'https://www.chess.com/game/live/80000000', uuid: 'august-game', pgn: PGNS[4], rules: 'chess', end_time: 1787000000 }] } },
    });
    let septemberDown = true;
    const flaky: typeof fetch = async (input, init) =>
      septemberDown && String(input).endsWith('/2026/09') ? new Response('{}', { status: 503 }) : base(input, init);
    const app = await instance({ seed: 'empty', fetch: flaky });
    const c = await client(app);
    await expect(c.request('games.importUser', { site: 'chesscom', username: 'coachverify' })).rejects.toMatchObject({
      code: 'site-unreachable',
      message: 'chess.com answered with an error (503). Try again later. The 1 game fetched before that is in your list, and fetching again carries on from there.',
    });
    expect(rows(app, 'SELECT source_id FROM games')).toEqual([{ source_id: 'august-game' }]);
    expect(rows(app, 'SELECT imported_through FROM site_imports')).toEqual([{ imported_through: 1787000000 * 1000 }]);

    septemberDown = false;
    const r = await c.request('games.importUser', { site: 'chesscom', username: 'coachverify' });
    expect(r).toMatchObject({ imported: 3, duplicates: 1, skippedUnfinished: 1 });
  });

  it('skips games that never started, counts unreadable ones, and asks again for a game still being played', async () => {
    const game = (id: string, status: string, createdAt: number, pgn: string | undefined) => JSON.stringify({ id, status, variant: 'standard', createdAt, pgn });
    const unfinished = (pgn: string) => pgn.replace(/\[Result "[^"]*"\]/, '[Result "*"]').replace(/ (1-0|0-1|1\/2-1\/2)\s*$/, ' *');
    const lines = [
      game('aborted1', 'aborted', 500, unfinished(PGNS[0] as string)),
      game('corresp1', 'started', 1000, unfinished(PGNS[1] as string)),
      game('garbled1', 'mate', 1500, 'not a PGN at all'),
      game('quick1', 'resign', 2000, PGNS[2] as string),
    ];
    const asked: { url: URL; body: unknown }[] = [];
    let byId = [game('corresp1', 'started', 1000, unfinished(PGNS[1] as string))];
    const logged: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      asked.push({ url, body: init?.body });
      return new Response((url.pathname === '/api/games/export/_ids' ? byId : lines).join('\n'), { status: 200 });
    };
    const app = await instance({ seed: 'empty', fetch: logged });
    const c = await client(app);
    expect(await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' })).toEqual({ imported: 1, duplicates: 0, skippedUnfinished: 1, unreadable: 1 });
    // The import moves past the correspondence game and notes it, so it doesn't hold later imports back.
    expect(rows(app, 'SELECT imported_through FROM site_imports')).toEqual([{ imported_through: 2000 }]);
    expect(rows(app, 'SELECT game_id FROM site_import_playing')).toEqual([{ game_id: 'corresp1' }]);
    expect(asked.map((a) => a.url.pathname)).toEqual(['/api/games/user/CoachVerify']);

    // Next time the export starts after quick1, and the correspondence game is asked for by id.
    lines.splice(0, lines.length, game('quick2', 'resign', 3000, PGNS[3] as string));
    asked.length = 0;
    expect(await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' })).toEqual({ imported: 1, duplicates: 0, skippedUnfinished: 1, unreadable: 0 });
    expect(asked[0]?.url.searchParams.get('since')).toBe('2000');
    expect(asked[1]?.url.pathname).toBe('/api/games/export/_ids');
    expect(asked[1]?.body).toBe('corresp1');
    expect(rows(app, 'SELECT imported_through FROM site_imports')).toEqual([{ imported_through: 3000 }]);
    expect(rows(app, 'SELECT game_id FROM site_import_playing')).toEqual([{ game_id: 'corresp1' }]);

    // Once it ends it is imported and no longer asked for; the import point stays where it was.
    byId = [game('corresp1', 'resign', 1000, PGNS[1] as string)];
    lines.splice(0, lines.length);
    expect(await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' })).toEqual({ imported: 1, duplicates: 0, skippedUnfinished: 0, unreadable: 0 });
    expect(rows<{ source_id: string }>(app, 'SELECT source_id FROM games').map((g) => g.source_id).sort()).toEqual(['corresp1', 'quick1', 'quick2']);
    expect(rows(app, 'SELECT * FROM site_import_playing')).toEqual([]);
    expect(rows(app, 'SELECT imported_through FROM site_imports')).toEqual([{ imported_through: 3000 }]);
    asked.length = 0;
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    expect(asked.map((a) => a.url.pathname)).toEqual(['/api/games/user/CoachVerify']);
  });

  it('stops chess.com short of a game still being played, and counts one that started before the import point', async () => {
    const october = `${CHESSCOM}/pub/player/coachverify/games/2026/10`;
    const finished = { url: 'https://www.chess.com/game/live/80000010', uuid: 'oct-10', pgn: PGNS[4], rules: 'chess', end_time: Date.UTC(2026, 9, 10) / 1000 };
    const month: { games: object[] } = { games: [finished] };
    const app = await instance({
      seed: 'empty',
      fetch: recordedFetch({
        [`${CHESSCOM}/pub/player/coachverify/games/archives`]: { status: 200, body: { archives: [october] } },
        [october]: { status: 200, body: month },
      }),
    });
    const c = await client(app);
    expect(await c.request('games.importUser', { site: 'chesscom', username: 'coachverify' })).toMatchObject({ imported: 1, skippedUnfinished: 0 });
    expect(rows(app, 'SELECT imported_through FROM site_imports')).toEqual([{ imported_through: Date.UTC(2026, 9, 10) }]);
    // A daily game with no end time counts as played on October 1st, before the import point.
    month.games.push({ url: 'https://www.chess.com/game/daily/80000011', uuid: 'daily', pgn: PGNS[5], rules: 'chess' });
    expect(await c.request('games.importUser', { site: 'chesscom', username: 'coachverify' })).toMatchObject({ imported: 0, duplicates: 1, skippedUnfinished: 1 });
    expect(rows(app, 'SELECT imported_through FROM site_imports')).toEqual([{ imported_through: Date.UTC(2026, 9, 10) }]);
  });

  it('turns down a chess.com rating lookup while chess.com games are being fetched', async () => {
    let release = () => {};
    const base = recordedFetch();
    const held: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/games/archives')) await new Promise<void>((r) => (release = r));
      return base(input, init);
    };
    const app = await instance({ seed: 'empty', fetch: held });
    const c = await client(app);
    const running = c.request('games.importUser', { site: 'chesscom', username: 'coachverify' });
    await new Promise((r) => setTimeout(r, 20));
    await expect(c.request('profile.update', { rating: { site: 'chesscom', username: 'coachverify' } as never })).rejects.toMatchObject({
      code: 'rate-limited',
      message: 'Games are being fetched from chess.com right now. Try again once that’s done.',
    });
    release();
    await expect(running).resolves.toMatchObject({ imported: 3 });
  });

  it('gives up on a site that stops answering, or sends an answer it can’t read', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    await expect(fetchGamesSince({ fetch: hang, timeoutMs: 20 }, 'chesscom', 'coachverify', 0, () => {})).rejects.toMatchObject({
      code: 'site-unreachable',
      message: 'chess.com stopped answering. Try again later.',
    });

    // Lichess sends one game, then goes quiet in the middle of its answer.
    const stall: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 'first', status: 'mate', variant: 'standard', pgn: PGNS[0] })}\n`));
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
          },
        }),
      );
    await expect(fetchGamesSince({ fetch: stall, timeoutMs: 20 }, 'lichess', 'CoachVerify', 0, () => {})).rejects.toMatchObject({
      message: 'Lichess stopped answering. Try again later.',
    });

    // A slow answer that keeps arriving is not a site that stopped answering.
    const trickle: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const piece of ['{"archives":', '[]', '}']) {
              await new Promise((r) => setTimeout(r, 15));
              controller.enqueue(new TextEncoder().encode(piece));
            }
            controller.close();
          },
        }),
      );
    await expect(fetchGamesSince({ fetch: trickle, timeoutMs: 30 }, 'chesscom', 'coachverify', 0, () => {})).resolves.toBeUndefined();

    // An unreadable line ends the import at once, and the rest of the answer is closed.
    let closed = false;
    const broken: typeof fetch = async (_input, init) => {
      init?.signal?.addEventListener('abort', () => (closed = true));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id": "half\n'));
          },
        }),
      );
    };
    await expect(fetchGamesSince({ fetch: broken }, 'lichess', 'CoachVerify', 0, () => {})).rejects.toMatchObject({
      message: 'Lichess sent an answer the app couldn’t read. Try again later.',
    });
    expect(closed).toBe(true);

    const garbled: typeof fetch = async () => new Response('<html>Down for maintenance</html>', { status: 200 });
    await expect(fetchGamesSince({ fetch: garbled }, 'chesscom', 'coachverify', 0, () => {})).rejects.toMatchObject({
      code: 'site-unreachable',
      message: 'chess.com sent an answer the app couldn’t read. Try again later.',
    });

    // A failure saving the games is the app's own, not the site's, and comes through as it is.
    const full = new Error('disk full');
    await expect(fetchGamesSince({ fetch: recordedFetch() }, 'lichess', 'CoachVerify', 0, () => {
      throw full;
    })).rejects.toBe(full);
  });

  it('reads the Player’s rating from Lichess and chess.com into the Player Profile', async () => {
    const app = await instance();
    const c = await client(app);
    expect(await c.request('profile.update', { rating: { site: 'lichess', username: 'CoachVerify' } })).toMatchObject({ rating: 1612 });
    expect(rows(app, 'SELECT rating, rating_site, rating_username FROM profile')).toEqual([{ rating: 1612, rating_site: 'lichess', rating_username: 'CoachVerify' }]);
    expect(await c.request('profile.update', { rating: { site: 'chesscom', username: 'coachverify' } })).toMatchObject({ rating: 1488 });
    expect(rows(app, 'SELECT rating, rating_site FROM profile')).toEqual([{ rating: 1488, rating_site: 'chesscom' }]);
  });

  it('keeps the linked account when a new username is unknown, and removes it on request', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('profile.update', { rating: { site: 'lichess', username: 'CoachVerify' } });
    await expect(c.request('profile.update', { rating: { site: 'lichess', username: 'NoSuchPlayer' }, level: 'club' })).rejects.toMatchObject({
      code: 'unknown-user',
    });
    // Nothing in the refused update is saved, not even the level that came with it.
    expect(rows(app, 'SELECT level, rating, rating_site, rating_username FROM profile')).toEqual([
      { level: 'casual', rating: 1612, rating_site: 'lichess', rating_username: 'CoachVerify' },
    ]);
    expect(await c.request('profile.update', { rating: null })).toMatchObject({ rating: null, ratingSource: null });
    expect(rows(app, 'SELECT rating, rating_site, rating_username FROM profile')).toEqual([{ rating: null, rating_site: null, rating_username: null }]);
  });

  it('saves nothing when the connection closes while the site is asked, as the app has said it wasn’t saved', async () => {
    const recorded = recordedFetch();
    let asked = false;
    let stopped = false;
    let answer = (): void => {};
    const held = new Promise<void>((resolve) => (answer = resolve));
    // A site that answers anyway, after the desktop has given up on it.
    const app = await instance({
      fetch: async (input, init) => {
        asked = true;
        init?.signal?.addEventListener('abort', () => (stopped = true));
        await held;
        return recorded(input, init);
      },
    });
    const c = await client(app);
    const save = c.request('profile.update', { level: 'club', rating: { site: 'lichess', username: 'CoachVerify' } }).catch(() => 'closed');
    await expect.poll(() => asked).toBe(true);
    await c.close();
    expect(await save).toBe('closed');
    await expect.poll(() => stopped).toBe(true);
    answer();
    // The rest of that save runs before the desktop reads another message, so a second device's
    // request is answered only after it.
    const other = await client(app);
    expect(await other.request('profile.get', {})).toMatchObject({ level: 'casual', rating: null, ratingSource: null });
    expect(rows(app, 'SELECT level, rating, rating_site FROM profile')).toEqual([{ level: 'casual', rating: null, rating_site: null }]);
  });

  it('saves nothing that arrives together with its connection’s close, as a desktop waking from sleep reads them', async () => {
    const app = await instance();
    const ws = new WebSocket(`${app.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(app.token)}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    // The app gave up on this save and closed the connection while the desktop was asleep: on
    // waking, the desktop reads the save and the close in one go.
    const save = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, id: '1', type: 'profile.update', level: 'club' }));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    (ws as unknown as { _socket: Socket })._socket.write(Buffer.concat([clientFrame(1, save), clientFrame(8, Buffer.from([0x03, 0xe8]))]));
    await closed;
    const other = await client(app);
    expect(await other.request('profile.get', {})).toMatchObject({ level: 'casual' });
    expect(rows(app, 'SELECT level FROM profile')).toEqual([{ level: 'casual' }]);
  });
});

describe('importing a PGN', () => {
  it('refuses a broken or unfinished PGN, asks for the side, and never adds a game twice', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    await expect(c.request('games.importPgn', { pgn: '1. e4 e5 2. Ke3 1-0' })).rejects.toMatchObject({ code: 'invalid-pgn', message: 'Move 2. Ke3 is not legal in that position.' });
    await expect(c.request('games.importPgn', { pgn: '1. e4 e5 *' })).rejects.toMatchObject({ code: 'invalid-pgn' });
    await expect(c.request('games.importPgn', { pgn: PGNS[0] as string })).rejects.toMatchObject({ code: 'needs-side' });
    const first = await c.request('games.importPgn', { pgn: PGNS[0] as string, playerSide: 'black' });
    expect(first).toMatchObject({ duplicate: false, game: { playerSide: 'black', opponent: 'Kozakmamay007', result: '1-0' } });
    const again = await c.request('games.importPgn', { pgn: `[Event "Same moves, other headers"]\n\n${(PGNS[0] as string).split('\n\n')[1]}` });
    expect(again.duplicate).toBe(true);
    expect(rows(app, 'SELECT * FROM games')).toHaveLength(1);
    const list = await c.request('games.list', {});
    expect(list.games[0]).toMatchObject({ date: expect.stringMatching(/^2012-12-31/), opening: expect.stringContaining('Giuoco Piano') });
  });

  it('imports a pasted game that ends in checkmate with no result, and says how to finish one that doesn’t', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const mate = await c.request('games.importPgn', { pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#', playerSide: 'white' });
    // With no name headers the sides are named by colour, not by PGN's "?".
    expect(mate.game).toMatchObject({ result: '1-0', playerSide: 'white', white: 'White', black: 'Black', opponent: 'Black' });
    await expect(c.request('games.importPgn', { pgn: '1. e4 e5 2. Nf3', playerSide: 'white' })).rejects.toMatchObject({
      code: 'invalid-pgn',
      message: 'That game has no result. Add it after the last move (1-0, 0-1 or 1/2-1/2), then import it again. Only finished games can be imported.',
    });
  });

  it('leaves the date unknown for a PGN that doesn’t give one, rather than using today', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const noDate = await c.request('games.importPgn', { pgn: '[White "Me"]\n[Black "Them"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', playerSide: 'white' });
    expect(noDate.game.date).toBeNull();
    const unknown = await c.request('games.importPgn', { pgn: '[Date "????.??.??"]\n\n1. d4 d5 2. c4 e6 1/2-1/2', playerSide: 'white' });
    expect(unknown.game.date).toBeNull();
    const dated = await c.request('games.importPgn', { pgn: '[Date "2024.03.09"]\n\n1. c4 e5 2. Nc3 Nf6 0-1', playerSide: 'white' });
    expect(dated.game.date).toBe('2024-03-09T00:00:00Z');
    const list = await c.request('games.list', {});
    expect(list.games.map((g) => g.date)).toEqual(expect.arrayContaining([null, null, '2024-03-09T00:00:00Z']));
    expect((await c.request('games.get', { gameId: noDate.game.id })).date).toBeNull();
  });

  it('treats an impossible calendar date in a PGN as unknown, the same as a missing one', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const feb30 = await c.request('games.importPgn', { pgn: '[Date "2020.02.30"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', playerSide: 'white' });
    expect(feb30.game.date).toBeNull();
    const month13 = await c.request('games.importPgn', { pgn: '[Date "2021.13.01"]\n\n1. d4 d5 2. c4 e6 1/2-1/2', playerSide: 'white' });
    expect(month13.game.date).toBeNull();
    const badTime = await c.request('games.importPgn', { pgn: '[UTCDate "2024.02.29"]\n[UTCTime "25:61:00"]\n\n1. c4 e5 2. Nc3 Nf6 0-1', playerSide: 'white' });
    expect(badTime.game.date).toBe('2024-02-29T00:00:00Z');
  });

  it('clears the made-up date of a dateless PGN imported before dates could be unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-dates-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // A database as it was before: no date_known column, the import time stored as the date.
    const old = openDb(dir);
    old.exec('ALTER TABLE games DROP COLUMN date_known; ALTER TABLE reviews DROP COLUMN overview; UPDATE schema_version SET version = 1;');
    const put = old.prepare(
      `INSERT INTO games (kind, source, source_id, pgn, start_fen, moves, white, black, player_side, result, opening, played_at, imported_at)
       VALUES ('imported', ?, ?, ?, ?, 'e2e4 e7e5', 'a', 'b', 'white', '1-0', 'x', ?, '2026-01-01T12:00:00.000Z')`,
    );
    put.run('pgn', 'nodate', '1. e4 e5 1-0', INITIAL_FEN, '2026-01-01T12:00:00.000Z');
    put.run('pgn', 'dated', '[Date "2024.03.09"]\n\n1. e4 e5 1-0', INITIAL_FEN, '2024-03-09T00:00:00Z');
    put.run('lichess', 'site', '[UTCDate "2013.01.01"]\n\n1. e4 e5 1-0', INITIAL_FEN, '2013-01-01T00:00:00Z');
    old.close();

    const db = openDb(dir);
    onTestFinished(() => db.close());
    expect(Object.fromEntries(listGames(db).map((g) => [g.sourceId, g.date]))).toEqual({
      nodate: null,
      dated: '2024-03-09T00:00:00Z',
      site: '2013-01-01T00:00:00Z',
    });
  });

  it('clears an impossible date stored before such dates were treated as unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-dates-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const old = openDb(dir);
    old.exec('ALTER TABLE reviews DROP COLUMN overview; UPDATE schema_version SET version = 2;');
    const put = old.prepare(
      `INSERT INTO games (kind, source, source_id, pgn, start_fen, moves, white, black, player_side, result, opening, played_at, date_known, imported_at)
       VALUES ('imported', 'pgn', ?, ?, ?, 'e2e4 e7e5', 'a', 'b', 'white', '1-0', 'x', ?, 1, '2026-01-01T12:00:00.000Z')`,
    );
    put.run('feb30', '[Date "2020.02.30"]\n\n1. e4 e5 1-0', INITIAL_FEN, '2020-02-30T00:00:00Z');
    put.run('leap', '[Date "2024.02.29"]\n\n1. e4 e5 1-0', INITIAL_FEN, '2024-02-29T00:00:00Z');
    old.close();

    const db = openDb(dir);
    onTestFinished(() => db.close());
    expect(Object.fromEntries(listGames(db).map((g) => [g.sourceId, g.date]))).toEqual({ feb30: null, leap: '2024-02-29T00:00:00Z' });
  });

  it('says which move is illegal, even in a PGN with no result', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    await expect(c.request('games.importPgn', { pgn: '1. e4 e5 2. Ke9 Nc6' })).rejects.toMatchObject({
      code: 'invalid-pgn',
      message: 'Move 2. Ke9 is not a legal move.',
    });
    expect(rows(app, 'SELECT * FROM games')).toHaveLength(0);
  });
});

describe('the game list', () => {
  it('comes a page at a time, newest first, with the total number of games', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    // More games than one page, imported oldest first, each played on its own day of 2020.
    const count = GAMES_PAGE_SIZE + 10;
    const firstMoves = ['e4', 'd4', 'c4', 'Nf3', 'g3', 'b3', 'f4', 'Nc3'];
    const replies = ['e5', 'd5', 'c5', 'Nf6', 'e6', 'c6', 'g6', 'd6'];
    const days: string[] = [];
    for (let i = 0; i < count; i++) {
      const day = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      days.push(day);
      const pgn = `[Date "${day.replaceAll('-', '.')}"]\n\n1. ${firstMoves[i % 8]} ${replies[Math.floor(i / 8) % 8]} 1/2-1/2`;
      expect((await c.request('games.importPgn', { pgn, playerSide: 'white' })).duplicate).toBe(false);
    }
    const newestFirst = [...days].reverse();

    const first = await c.request('games.list', {});
    expect(first.total).toBe(count);
    expect(first.games.map((g) => g.date?.slice(0, 10))).toEqual(newestFirst.slice(0, GAMES_PAGE_SIZE));

    const next = await c.request('games.list', { offset: GAMES_PAGE_SIZE });
    expect(next.total).toBe(count);
    expect(next.games.map((g) => g.date?.slice(0, 10))).toEqual(newestFirst.slice(GAMES_PAGE_SIZE));
    expect(next.games).toHaveLength(10);

    // A client can ask for as many games as it already shows, to refresh them in one request.
    const some = await c.request('games.list', { offset: 5, limit: 3 });
    expect(some.games.map((g) => g.date?.slice(0, 10))).toEqual(newestFirst.slice(5, 8));
    expect((await c.request('games.list', { offset: count })).games).toEqual([]);

    await expect(c.request('games.list', { offset: -1 })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.request('games.list', { limit: 0 })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.request('games.list', { limit: 1.5 })).rejects.toMatchObject({ code: 'bad-request' });
  });
});

describe('Reviews', () => {
  it('saves the Review, then rereads it with no Coach call', async () => {
    const app = await instance();
    const c = await client(app);
    const game = await c.request('games.get', { gameId: 1 });
    const parts = new Set<ReviewPart>();
    const progress: number[] = [];
    const review = await c.request('review.start', { gameId: 1 }, (_t, part) => parts.add(part ?? -1), (done) => progress.push(done));
    // The desktop's Engine graded every position, and reported each one.
    expect(progress).toEqual(Array.from({ length: game.moves.length + 1 }, (_, i) => i + 1));
    expect(review.moments.map((m) => `${m.ply}:${m.san}:${m.grade}`)).toEqual(['21:Bxf7+:Mistake', '23:Bg5:Mistake', '35:d5:Inaccuracy', '47:Bxc5:Inaccuracy']);
    // The overview streamed first, then each key moment.
    expect([...parts]).toEqual(['overview', 0, 1, 2, 3]);
    for (const m of review.moments) expect(m.explanation).toContain(m.san);
    expect(rows(app, "SELECT * FROM coach_calls WHERE job = 'review-moment'")).toHaveLength(4);
    const calls = rows(app, 'SELECT * FROM coach_calls').length;
    expect(calls).toBe(5);

    const again = await c.request('review.start', { gameId: 1 });
    const reread = await c.request('review.get', { gameId: 1 });
    expect(again).toEqual(review);
    expect(reread.review).toEqual(review);
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(calls);
    // The Move Grade counts went into the Player Profile.
    const profile = await c.request('profile.get', {});
    expect(Object.values(profile.gradeCounts)[0]).toMatchObject({ Mistake: 2, Inaccuracy: 2 });
  });

  it('opens with the Coach’s overview of the whole game, from the fake Coach’s recorded reply, saved with the Review', async () => {
    const app = await instance();
    const c = await client(app);
    const review = await c.request('review.start', { gameId: 1 });
    // The recorded reply for game 1 (verify/recordings/coach.json), and the game's moves it names, in game order.
    expect(review.overview?.text).toMatch(/^Your opening went well, and your opponent had to find 9… d5 there/);
    expect(review.overview?.moves.map((m) => `${m.label} ${m.side} ${m.grade}`)).toEqual([
      '9… d5 black Best',
      '11. Bxf7+ white Mistake',
      '12. Bg5 white Mistake',
      '18. d5 white Inaccuracy',
      '24. Bxc5 white Inaccuracy',
    ]);
    expect(review.overview?.moves.map((m) => m.ply)).toEqual([18, 21, 23, 35, 47]);

    // One overview call, on the Review moments' model, before any key moment.
    const calls = rows<{ job: string; model: string; brief: string; stripped: string }>(app, 'SELECT job, model, brief, stripped FROM coach_calls ORDER BY id');
    expect(calls.map((r) => r.job)).toEqual(['review-overview', 'review-moment', 'review-moment', 'review-moment', 'review-moment']);
    expect(calls[0]?.model).toBe('sonnet');
    // Its recorded brief: Move Grade counts for both sides, the key moments and the standout moves, within its budget (ADR 0004).
    const brief = JSON.parse(calls[0]?.brief as string) as Brief;
    expect(calls[0]?.brief.length).toBeLessThanOrEqual(BRIEF_BUDGET);
    expect(brief.game).toMatchObject({
      grades: { player: 'Best 10, Good 10, Inaccuracy 2, Mistake 2, Blunder 0', opponent: 'Best 14, Good 9, Inaccuracy 1, Mistake 0, Blunder 0' },
      standouts: [{ move: '9… d5', by: 'black', grade: 'Best', only: true }],
    });
    expect(brief.game?.moments.map((m) => m.move)).toEqual(['11. Bxf7+', '12. Bg5', '18. d5', '24. Bxc5']);
    // Every move in the recorded reply came from the brief: the guard stripped nothing.
    expect(JSON.parse(calls[0]?.stripped as string)).toEqual([]);
    // The Review's one Player Profile note is the overview's, a pattern across the whole game.
    expect(rows<{ text: string }>(app, 'SELECT text FROM coach_notes').map((n) => n.text)).toEqual(['Lets one Mistake follow another in the middlegame.']);
    expect(rows<{ allowNote: boolean }>(app, "SELECT json_extract(brief, '$.allowNote') AS allowNote FROM coach_calls WHERE job = 'review-moment'").map((r) => r.allowNote)).toEqual([0, 0, 0, 0]);

    // Reopened, the overview is there with no Coach call.
    const reread = await c.request('review.get', { gameId: 1 });
    expect(reread.review?.overview).toEqual(review.overview);
    expect(await c.request('review.start', { gameId: 1 })).toEqual(review);
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(5);
  });

  it('gives game 1 reviewed as Black an overview for Black: the recording is White’s alone', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('games.setSide', { gameId: 1, playerSide: 'black' });
    const review = await c.request('review.start', { gameId: 1 });
    // The fake Coach's template, from the brief for Black: Black's Move Grades are the Player's.
    expect(review.overview?.text).toMatch(/^Your Move Grades: Best 14, Good 9, Inaccuracy 1, Mistake 0, Blunder 0\./);
    expect(review.overview?.moves.map((m) => m.label)).toEqual(['9… d5', '11. Bxf7+', '12. Bg5', '16… Nc6']);
    const [call] = rows<{ stripped: string }>(app, "SELECT stripped FROM coach_calls WHERE job = 'review-overview'");
    expect(JSON.parse(call?.stripped as string)).toEqual([]);
  });

  it('saves the overview’s Player Profile note with the Review, so a Review that fails leaves none', async () => {
    const app = await instance();
    const c = await client(app);
    // The overview writes a note, then the Coach can't be reached for the first key moment.
    app.coach.script({ kind: 'reply', reply: { note: 'Loses the thread after the opening.' } });
    app.coach.script({ kind: 'unavailable' });
    await expect(c.request('review.start', { gameId: 1 })).rejects.toMatchObject({ code: 'coach-unavailable' });
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(0);
    expect(rows(app, 'SELECT * FROM coach_notes')).toEqual([]);
    // Started again, the Review saves one note: the new overview's.
    app.coach.script({ kind: 'reply', reply: { note: 'Lets the middlegame slip after a good opening.' } });
    await c.request('review.start', { gameId: 1 });
    expect(rows<{ text: string }>(app, 'SELECT text FROM coach_notes').map((n) => n.text)).toEqual(['Lets the middlegame slip after a good opening.']);
  });

  it('makes no overview of a game with no moves', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const { game } = await c.request('games.saveEngineGame', {
      game: { clientId: 'resigned-at-once', playerSide: 'white', strength: 2, moves: [], result: '0-1', termination: 'resignation', startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:05.000Z' },
    });
    const review = await c.request('review.start', { gameId: game.id });
    expect(review).toMatchObject({ overview: null, moments: [] });
    expect(rows(app, 'SELECT * FROM coach_calls')).toEqual([]);
  });

  it('runs the overview on the model set for Review moments, whatever it is', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { models: { 'review-moment': 'opus' } });
    await c.request('review.start', { gameId: 1 });
    expect(rows<{ job: string; model: string }>(app, 'SELECT DISTINCT job, model FROM coach_calls')).toEqual([
      { job: 'review-overview', model: 'opus' },
      { job: 'review-moment', model: 'opus' },
    ]);
  });

  it('strips any move the overview names that its brief doesn’t list, and draws nothing', async () => {
    const app = await instance();
    const c = await client(app);
    app.coach.script({
      kind: 'reply',
      reply: { text: 'It went wrong with 11. Bxf7+, not 1. e4.', moves: ['c4f7', 'e2e4'], arrows: [{ uci: 'c4f7', brush: 'red' }], highlights: ['f7'], note: null },
    });
    const review = await c.request('review.start', { gameId: 1 });
    expect(review.overview?.moves.map((m) => m.label)).toEqual(['11. Bxf7+']);
    const [call] = rows<{ stripped: string }>(app, "SELECT stripped FROM coach_calls WHERE job = 'review-overview'");
    expect(JSON.parse(call?.stripped as string)).toEqual(["move e2e4 is not in the Engine's output", 'arrow c4f7: an overview draws no arrows']);
    // With no note from the overview, the last key moment may still add the Review's one note.
    expect(rows<{ allowNote: number }>(app, "SELECT json_extract(brief, '$.allowNote') AS allowNote FROM coach_calls WHERE job = 'review-moment'").map((r) => r.allowNote)).toEqual([0, 0, 0, 1]);
  });

  it('with the overview turned off in Settings, makes the key moments only, with no overview call', async () => {
    const app = await instance();
    const c = await client(app);
    expect(await c.request('settings.get', {})).toMatchObject({ reviewOverview: true });
    expect(await c.request('settings.update', { reviewOverview: false })).toMatchObject({ reviewOverview: false });
    const parts = new Set<ReviewPart>();
    const review = await c.request('review.start', { gameId: 1 }, (_t, part) => parts.add(part ?? -1));
    expect(review.overview).toBeNull();
    expect(review.moments).toHaveLength(4);
    expect([...parts]).toEqual([0, 1, 2, 3]);
    // The Coach call log has the four key moments and nothing else.
    expect(rows<{ job: string }>(app, 'SELECT job FROM coach_calls').map((r) => r.job)).toEqual(['review-moment', 'review-moment', 'review-moment', 'review-moment']);
    // Turned on again, a Review saved without an overview stays that way.
    await c.request('settings.update', { reviewOverview: true });
    expect((await c.request('review.get', { gameId: 1 })).review?.overview).toBeNull();
    expect((await c.request('review.start', { gameId: 1 })).overview).toBeNull();
    expect(rows(app, 'SELECT * FROM coach_calls')).toHaveLength(4);
  });

  it('reads a Review saved before there were overviews as one with no overview', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-overview-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // A database as it was before: no overview column, and a saved Review of game 1.
    const old = openDb(dir);
    seed(old, new FakeClock(), 'default');
    old.exec('ALTER TABLE reviews DROP COLUMN overview; UPDATE schema_version SET version = version - 1;');
    old.prepare("INSERT INTO reviews (game_id, created_at, moments) VALUES (1, '2026-01-01T12:00:00.000Z', '[]')").run();
    old.close();

    const db = openDb(dir);
    onTestFinished(() => db.close());
    expect(getReview(db, 1)).toMatchObject({ gameId: 1, overview: null, moments: [] });
  });

  it('Reviews the sample game without counting it in the Player Profile', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const { game, duplicate } = await c.request('games.importSample', {});
    expect(game).toMatchObject({ source: 'sample', playerSide: 'white', white: 'bijean', black: 'ikatsca' });
    expect(duplicate).toBe(false);
    expect(await c.request('games.importSample', {})).toMatchObject({ game: { id: game.id }, duplicate: true });

    // Every Coach reply offers a note, as a real Coach might: the overview's and each key moment's.
    for (let i = 0; i < 5; i++) app.coach.script({ kind: 'reply', reply: { note: 'Gives up the bishop for a pawn too early.' } });
    const review = await c.request('review.start', { gameId: game.id });
    expect(review.moments.map((m) => `${m.ply}:${m.san}:${m.grade}`)).toEqual(['21:Bxf7+:Mistake', '23:Bg5:Mistake', '35:d5:Inaccuracy', '47:Bxc5:Inaccuracy']);
    // The Review works, but the sample is not the Player's game: no Move Grade counts, no Coach note.
    expect(rows(app, 'SELECT * FROM grade_counts')).toEqual([]);
    expect(rows(app, 'SELECT * FROM coach_notes')).toEqual([]);
    expect((await c.request('profile.get', {})).gradeCounts).toEqual({});
  });

  it('keeps the Player’s own Move Grade counts when the reviewed sample is deleted or changes side', async () => {
    // The seeded game 1 is the Player's, in the sample's opening, so their counts share a row.
    const app = await instance();
    const c = await client(app);
    await c.request('review.start', { gameId: 1 });
    const counts = rows(app, 'SELECT * FROM grade_counts');
    expect(counts.length).toBeGreaterThan(0);
    const { game: sample } = await c.request('games.importSample', {});
    await c.request('review.start', { gameId: sample.id });

    await c.request('games.setSide', { gameId: sample.id, playerSide: 'black', dropReview: true });
    expect(rows(app, 'SELECT * FROM grade_counts')).toEqual(counts);
    await c.request('review.start', { gameId: sample.id });
    await c.request('games.delete', { gameId: sample.id });
    expect(rows(app, 'SELECT * FROM grade_counts')).toEqual(counts);
  });

  it('grades on the desktop’s Engine exactly as the shared grader does at the same depth (ADR 0007)', async () => {
    const app = await instance();
    const c = await client(app);
    const game = await c.request('games.get', { gameId: 1 });
    const expected = await gradeGame(await createNodeEngine(), game.moves, VERIFY_ENGINE);
    const review = await c.request('review.start', { gameId: 1 });
    expect(review.moves).toEqual(expected);
  });

  it('starts one Review when asked twice at once, and answers both requests with it', async () => {
    const app = await instance();
    const c = await client(app);
    const [first, second] = await Promise.all([c.request('review.start', { gameId: 1 }), c.request('review.start', { gameId: 1 })]);
    expect(second).toEqual(first);
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(1);
    expect(rows(app, "SELECT * FROM coach_calls WHERE job = 'review-moment'")).toHaveLength(first.moments.length);
    // The Move Grades were counted into the Player Profile once.
    const profile = await c.request('profile.get', {});
    expect(Object.values(profile.gradeCounts)[0]).toMatchObject({ Mistake: 2, Inaccuracy: 2 });
  });

  it('checks the Coach can answer before grading the game', async () => {
    const app = await instance();
    const c = await client(app);
    app.app.coach.setUnavailable('Claude Code is not logged in on the desktop.');
    await expect(c.request('review.start', { gameId: 1 }, undefined, () => undefined)).rejects.toMatchObject({ code: 'coach-unavailable' });
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(0);
  });

  /** Starts game 1's Review on a connection, and closes that connection once a few positions are graded. */
  async function dropMidReview(app: Awaited<ReturnType<typeof instance>>): Promise<void> {
    const first = await client(app);
    let graded = 0;
    const asked = first.request('review.start', { gameId: 1 }, undefined, (done) => (graded = done)).catch(() => undefined);
    await expect.poll(() => graded, { timeout: 30_000 }).toBeGreaterThan(2);
    await first.close();
    await asked;
  }

  it('asked again on a new connection after a drop, joins the Review still being made and hears its progress', async () => {
    const app = await instance();
    await dropMidReview(app);
    // Right away, as the app's retry after a blip does: the Review is still being made.
    const again = await client(app);
    const progress: number[] = [];
    const parts = new Set<ReviewPart>();
    const review = await again.request('review.start', { gameId: 1 }, (_t, part) => parts.add(part ?? -1), (done) => progress.push(done));
    expect(review.moments).toHaveLength(4);
    // It joined: where the Review had got to first, then the rest, and the overview and every explanation the Coach wrote.
    expect(progress[0]).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(49);
    expect([...parts]).toEqual(['overview', 0, 1, 2, 3]);
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(1);
    expect(rows(app, "SELECT * FROM coach_calls WHERE job = 'review-moment'")).toHaveLength(4);
  });

  it('finishes and saves a Review nobody is waiting for any more, and says it is being made meanwhile', async () => {
    const app = await instance();
    // A tab closed or reloaded mid-Review: nobody asks again.
    await dropMidReview(app);
    const c = await client(app);
    expect(await c.request('review.get', { gameId: 1 })).toEqual({ review: null, beingMade: true });
    await expect.poll(async () => (await c.request('review.get', { gameId: 1 })).review?.moments.length, { timeout: 60_000 }).toBe(4);
    expect(await c.request('review.get', { gameId: 1 })).toMatchObject({ beingMade: false });
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(1);
  });

  it('stops a Review when the desktop app closes', async () => {
    const app = await instance();
    const engine = app.app.context.desktopEngine;
    const analyse = engine.analyse.bind(engine);
    let analysed = 0;
    engine.analyse = (fen) => {
      analysed++;
      return analyse(fen);
    };
    const c = await client(app);
    let graded = 0;
    const asked = c.request('review.start', { gameId: 1 }, undefined, (done) => (graded = done)).catch(() => undefined);
    await expect.poll(() => graded, { timeout: 30_000 }).toBeGreaterThan(2);
    const atStop = analysed;
    await app.stop();
    await asked;
    await expect.poll(() => reviewInProgress(app.app.db, 1), { timeout: 30_000 }).toBe(false);
    // The Engine stopped with it rather than grade the other 40-odd positions for nobody.
    expect(analysed).toBeLessThanOrEqual(atStop + 2);
  });
});

describe('Engine Games', () => {
  const record = (clientId: string): EngineGameRecord => ({
    clientId,
    playerSide: 'white',
    strength: 2,
    moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
    result: '1-0',
    termination: 'checkmate',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
  });

  it('saves a finished game once, and syncs games played offline', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const saved = await c.request('games.saveEngineGame', { game: record('client-a') });
    expect(saved.game).toMatchObject({ source: 'engine', opponent: 'Engine (Casual)', result: '1-0' });
    const sync = await c.request('games.syncOffline', { games: [record('client-a'), record('client-b')] });
    expect(sync).toMatchObject({ duplicates: 1 });
    expect(sync.saved).toHaveLength(2);
    expect(rows(app, "SELECT * FROM games WHERE kind = 'engine'")).toHaveLength(2);
    const detail = await c.request('games.get', { gameId: saved.game.id });
    expect(detail.pgn).toContain('Qxf7#');
  });

  it('refuses an illegal move list', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    await expect(c.request('games.saveEngineGame', { game: { ...record('client-x'), moves: ['e2e5'] } })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('names the Engine by its level, also in games saved when it was "Engine (level 2)"', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const saved = await c.request('games.saveEngineGame', { game: record('client-a') });
    expect((await c.request('games.get', { gameId: saved.game.id })).pgn).toContain('[Black "Engine (Casual)"]');
    app.app.db.prepare("UPDATE games SET black = 'Engine (level 2)' WHERE id = ?").run(saved.game.id);
    const { games } = await c.request('games.list', {});
    expect(games[0]).toMatchObject({ white: 'You', black: 'Engine (Casual)', opponent: 'Engine (Casual)' });
    // Only Engine Games: an imported opponent keeps whatever name the site gave them.
    app.app.db.prepare("UPDATE games SET source = 'pgn' WHERE id = ?").run(saved.game.id);
    expect((await c.request('games.list', {})).games[0]?.opponent).toBe('Engine (level 2)');
  });
});

describe('fixing the side of a game and deleting a game', () => {
  const gradeCounts = async (c: Awaited<ReturnType<typeof client>>) => Object.values((await c.request('profile.get', {})).gradeCounts);

  it('changes the side of an Imported Game, and drops its Review and the Move Grades it counted', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('review.start', { gameId: 1 });
    expect(await gradeCounts(c)).toEqual([expect.objectContaining({ Mistake: 2, Inaccuracy: 2 })]);

    // A list loaded before the Review was made doesn't know it would go: the desktop asks first.
    await expect(c.request('games.setSide', { gameId: 1, playerSide: 'black' })).rejects.toMatchObject({ code: 'needs-confirm' });
    expect(rows(app, 'SELECT player_side FROM games WHERE id = 1')).toEqual([{ player_side: 'white' }]);
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(1);

    const black = await c.request('games.setSide', { gameId: 1, playerSide: 'black', dropReview: true });
    expect(black).toMatchObject({ id: 1, playerSide: 'black', opponent: 'bijean', hasReview: false });
    expect(rows(app, 'SELECT player_side FROM games WHERE id = 1')).toEqual([{ player_side: 'black' }]);
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(0);
    expect(rows(app, 'SELECT * FROM graded_moves')).toHaveLength(0);
    // White's Move Grades no longer count towards the Player Profile.
    expect(await gradeCounts(c)).toEqual([]);

    // A new Review is about Black's moves, and counts them once.
    const review = await c.request('review.start', { gameId: 1 });
    const blackMoves = review.moves.filter((m) => m.side === 'black');
    const total = Object.values((await gradeCounts(c))[0] ?? {}).reduce((n, x) => n + (x ?? 0), 0);
    expect(total).toBe(blackMoves.length);

    // The side it already has changes nothing, and keeps the Review.
    expect(await c.request('games.setSide', { gameId: 1, playerSide: 'black' })).toMatchObject({ playerSide: 'black', hasReview: true });
  });

  it('deletes a game with its Review and the Move Grades it counted', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('review.start', { gameId: 1 });
    expect(await c.request('games.delete', { gameId: 1 })).toEqual({ total: 0 });
    expect(rows(app, 'SELECT * FROM games')).toHaveLength(0);
    expect(rows(app, 'SELECT * FROM reviews')).toHaveLength(0);
    expect(rows(app, 'SELECT * FROM graded_moves')).toHaveLength(0);
    expect(await gradeCounts(c)).toEqual([]);
    await expect(c.request('games.get', { gameId: 1 })).rejects.toMatchObject({ code: 'not-found' });
    await expect(c.request('games.delete', { gameId: 1 })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('keeps an Engine Game’s side, and changes nothing while the game’s Review is being made', async () => {
    const app = await instance();
    const c = await client(app);
    const engine = await c.request('games.saveEngineGame', {
      game: {
        clientId: 'client-side',
        playerSide: 'white',
        strength: 1,
        moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
        result: '1-0',
        termination: 'checkmate',
        startedAt: '2026-01-01T10:00:00.000Z',
        finishedAt: '2026-01-01T10:05:00.000Z',
      },
    });
    await expect(c.request('games.setSide', { gameId: engine.game.id, playerSide: 'black' })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.request('games.setSide', { gameId: 1, playerSide: 'red' as 'white' })).rejects.toMatchObject({ code: 'bad-request' });

    const reviewing = c.request('review.start', { gameId: 1 });
    await expect(c.request('games.setSide', { gameId: 1, playerSide: 'black' })).rejects.toMatchObject({ code: 'bad-request', message: expect.stringContaining('Review') });
    await expect(c.request('games.delete', { gameId: 1 })).rejects.toMatchObject({ code: 'bad-request', message: expect.stringContaining('Review') });
    await reviewing;
    expect(rows(app, 'SELECT player_side FROM games WHERE id = 1')).toEqual([{ player_side: 'white' }]);
  });

  it('knows the Player’s side in a pasted PGN from the usernames their games were fetched for', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    const pasted = await c.request('games.importPgn', { pgn: '[White "Someone"]\n[Black "coachverify"]\n\n1. f3 e5 2. g4 Qh4# 0-1' });
    expect(pasted.game).toMatchObject({ playerSide: 'black', opponent: 'Someone' });
  });

  it('asks for the side of a pasted game between two usernames whose games were fetched', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    // A second username fetched, such as a friend's: an import by username takes any name.
    app.app.db.prepare("INSERT INTO site_imports (site, username, imported_through) VALUES ('chesscom', 'afriend', 1)").run();
    const pgn = '[White "CoachVerify"]\n[Black "afriend"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
    await expect(c.request('games.importPgn', { pgn })).rejects.toMatchObject({ code: 'needs-side' });
    expect(rows(app, "SELECT * FROM games WHERE source = 'pgn'")).toHaveLength(0);
  });

  it('never brings a deleted game back when the Player fetches that username again', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    const idOf = (sourceId: string) => rows<{ id: number }>(app, 'SELECT id FROM games WHERE source_id = ?', sourceId)[0]?.id;
    // chess.com hands the newest game over again on every import (and, with a daily game still
    // being played, every game of that month).
    await c.request('games.importUser', { site: 'chesscom', username: 'coachverify' });
    for (const uuid of ['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000002']) {
      await c.request('games.delete', { gameId: idOf(uuid) as number });
      await c.request('games.importUser', { site: 'chesscom', username: 'coachverify' });
      expect(idOf(uuid)).toBeUndefined();
    }
    // The recorded Lichess answers hand every game over again, whatever the import point.
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    const pgn = rows<{ pgn: string }>(app, "SELECT pgn FROM games WHERE source_id = 'wvkkfh56'")[0]?.pgn as string;
    await c.request('games.delete', { gameId: idOf('wvkkfh56') as number });
    expect(await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' })).toMatchObject({ imported: 0, duplicates: 2, skippedUnfinished: 1 });
    expect(idOf('wvkkfh56')).toBeUndefined();
    expect(rows(app, 'SELECT source, source_id FROM deleted_games ORDER BY source, source_id')).toEqual([
      { source: 'chesscom', source_id: '00000000-0000-4000-8000-000000000000' },
      { source: 'chesscom', source_id: '00000000-0000-4000-8000-000000000002' },
      { source: 'lichess', source_id: 'wvkkfh56' },
    ]);

    // Pasting a deleted game brings it back: the Player asked for it.
    expect(await c.request('games.importPgn', { pgn })).toMatchObject({ duplicate: false, game: { source: 'pgn', playerSide: 'black' } });
  });

  it('brings a deleted pasted game back when the Player pastes it again', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('games.delete', { gameId: 1 });
    expect(await c.request('games.importPgn', { pgn: SEED_GAME_PGN, playerSide: 'white' })).toMatchObject({ duplicate: false, game: { opponent: 'ikatsca' } });
    expect(rows(app, 'SELECT * FROM deleted_games')).toEqual([]);
  });
});

it('seeds a known state', async () => {
  const app = await instance();
  expect(rows<{ pgn: string }>(app, 'SELECT pgn FROM games')[0]?.pgn).toBe(SEED_GAME_PGN);
  expect(rows<{ onboarded: number; level: string }>(app, 'SELECT onboarded, level FROM profile')[0]).toEqual({ onboarded: 1, level: 'casual' });
});
