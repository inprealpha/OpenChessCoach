// The tempting moves (ADR 0011): Maia-3's input and output, its parity with the original model, the
// model download, the choice between Maia-3, Opus and the fake, and what the desktop reports.
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_FEN, playSan, playUci } from '@chess-coach/shared/chess';
import { BRIEF_BUDGET, briefSize, buildBrief, type Brief, type BriefCandidate } from '@chess-coach/shared/coach/brief';
import { guardReply } from '@chess-coach/shared/coach/guard';
import { defaultDataDir } from '../src/paths.ts';
import { MAIA3_5M, ModelDownloader, type ModelAsset } from '../src/tempting-moves/download.ts';
import { FakeTemptingMoves } from '../src/tempting-moves/fake.ts';
import { MAIA_WIDTH, MaiaTemptingMoves, maiaInput, maiaMoveIndex, gamePositions } from '../src/tempting-moves/maia.ts';
import { instinctPrompt, legalOnly, OPUS_OUTPUT_TOKENS, OpusTemptingMoves } from '../src/tempting-moves/opus.ts';
import type { TemptingMovesPort } from '../src/tempting-moves/port.ts';
import { TemptingMovesService } from '../src/tempting-moves/service.ts';
import { historyFromSans } from '../src/tempting-moves/ask.ts';
import { maiaRating, playerMaiaRating } from '../src/tempting-moves/rating.ts';
import { client, instance, rows } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'chess-coach-models-'));
  dirs.push(d);
  return d;
};

describe("Maia-3's input and output", () => {
  it('numbers moves from the side to move, with promotions after the 4,096 plain moves', () => {
    expect(maiaMoveIndex('e2e4', false)).toBe(12 * 64 + 28);
    // Black's e7e5 is White's e2e4 on the mirrored board.
    expect(maiaMoveIndex('e7e5', true)).toBe(12 * 64 + 28);
    expect(maiaMoveIndex('e1g1', false)).toBe(4 * 64 + 6);
    expect(maiaMoveIndex('a7a8q', false)).toBe(4096);
    expect(maiaMoveIndex('h2h1n', true)).toBe(4351);
  });

  it('encodes the last 8 positions, each from its own side to move, the first repeated', () => {
    const input = maiaInput(gamePositions(INITIAL_FEN, ['e2e4']));
    expect(input).toHaveLength(64 * MAIA_WIDTH);
    const at = (square: number, slot: number, plane: number) => input[square * MAIA_WIDTH + slot * 12 + plane];
    // Slots 0–6 repeat the start position, White to move: White's rook on a1 is the mover's rook.
    for (let slot = 0; slot < 7; slot++) expect(at(0, slot, 3)).toBe(1);
    // Slot 7 is after 1. e4, Black to move, mirrored: Black's rook on a8 is on a1, as the mover's;
    // White's pawn on e4 (28) is on e5 (36), as the opponent's.
    expect(at(0, 7, 3)).toBe(1);
    expect(at(36, 7, 6)).toBe(1);
    expect(at(28, 7, 0)).toBe(0);
    // 32 pieces in each of the 8 positions, and nothing in the think-time column.
    expect(input.reduce((a, b) => a + b, 0)).toBe(32 * 8);
    for (let sq = 0; sq < 64; sq++) expect(input[sq * MAIA_WIDTH + MAIA_WIDTH - 1]).toBe(0);
  });

  it('refuses a game with an illegal move', () => {
    expect(() => gamePositions(INITIAL_FEN, ['e2e5'])).toThrow('not legal');
  });
});

// The 408 positions of the research's quick-move set, with the original Maia-3 5M's top three from
// Python. It runs when the model file is on this desktop: MAIA_MODEL, or the app's downloaded copy.
const modelPath = process.env.MAIA_MODEL ?? join(defaultDataDir(), 'models', `${MAIA3_5M.name}-${MAIA3_5M.sha256.slice(0, 8)}.onnx`);
describe.skipIf(!existsSync(modelPath))('Maia-3 parity with the original model', () => {
  it('gives the same top three, in the same order, as Python in all 408 positions', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/maia3-parity.json', import.meta.url), 'utf8')) as {
      positions: { id: string; moves: string; rating: number; opponentRating: number; top3: string }[];
    };
    const maia = await MaiaTemptingMoves.load(new Uint8Array(readFileSync(modelPath)), 4);
    const different: string[] = [];
    for (const p of fixture.positions) {
      const { moves } = await maia.suggest({ startFen: INITIAL_FEN, moves: p.moves ? p.moves.split(' ') : [], rating: p.rating, opponentRating: p.opponentRating });
      if (moves.join(' ') !== p.top3) different.push(`${p.id}: ${moves.join(' ')} instead of ${p.top3}`);
    }
    await maia.close();
    expect(fixture.positions).toHaveLength(408);
    expect(different).toEqual([]);
  }, 600_000);
});

/** A small file standing in for the model, and a server for it that honours Range requests. */
function fakeAsset(size = 1000): { asset: ModelAsset; data: Buffer } {
  const data = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7) % 256));
  return { asset: { name: 'test-model', url: 'https://example.test/test-model.onnx', bytes: size, sha256: createHash('sha256').update(data).digest('hex') }, data };
}

interface ServerOptions {
  ignoreRange?: boolean;
  /** Stop the body after this many bytes, as a dropped connection does. */
  breakAfter?: number;
  status?: number;
  body?: Buffer;
}

function server(data: Buffer, options: ServerOptions = {}) {
  const requests: { range: string | null }[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    requests.push({ range });
    if (options.status) return new Response('nope', { status: options.status });
    const body = options.body ?? data;
    const start = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const slice = body.subarray(start);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          // The second read: a dropped connection fails here, after the first part has arrived.
          if (options.breakAfter !== undefined) controller.error(new Error('the connection dropped'));
          else controller.close();
          return;
        }
        sent = true;
        controller.enqueue(new Uint8Array(options.breakAfter !== undefined ? slice.subarray(0, options.breakAfter) : slice));
      },
    });
    return start > 0
      ? new Response(stream, { status: 206, headers: { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } })
      : new Response(stream, { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

describe('the model download', () => {
  it('downloads, checks the SHA-256 and only then gives the file its final name', async () => {
    const { asset, data } = fakeAsset();
    const dir = tempDir();
    const srv = server(data);
    const d = new ModelDownloader({ dir, asset, fetch: srv.fetch, retryDelaysMs: [] });
    expect(d.state().model).toBe('missing');
    await d.attempt();
    expect(d.state()).toMatchObject({ model: 'ready' });
    expect(readFileSync(d.path)).toEqual(data);
    expect(d.path).toBe(join(dir, `test-model-${asset.sha256.slice(0, 8)}.onnx`));
    expect(existsSync(`${d.path}.part`)).toBe(false);
    expect(existsSync(join(dir, 'test-model.lock'))).toBe(false);
  });

  it('resumes an interrupted download with a Range request', async () => {
    const { asset, data } = fakeAsset();
    const dir = tempDir();
    const d = new ModelDownloader({ dir, asset, fetch: server(data, { breakAfter: 400 }).fetch, retryDelaysMs: [] });
    await d.attempt();
    expect(d.state()).toMatchObject({ model: 'failed', detail: expect.stringContaining('the connection dropped') });
    expect(statSync(`${d.path}.part`).size).toBe(400);
    expect(existsSync(d.path)).toBe(false);

    const srv = server(data);
    const again = new ModelDownloader({ dir, asset, fetch: srv.fetch, retryDelaysMs: [] });
    await again.attempt();
    expect(srv.requests).toEqual([{ range: 'bytes=400-' }]);
    expect(again.state().model).toBe('ready');
    expect(readFileSync(again.path)).toEqual(data);
  });

  it('starts again from zero when the server ignores the range', async () => {
    const { asset, data } = fakeAsset();
    const dir = tempDir();
    writeFileSync(join(dir, `test-model-${asset.sha256.slice(0, 8)}.onnx.part`), data.subarray(0, 300));
    const d = new ModelDownloader({ dir, asset, fetch: server(data, { ignoreRange: true }).fetch, retryDelaysMs: [] });
    await d.attempt();
    expect(d.state().model).toBe('ready');
    expect(readFileSync(d.path)).toEqual(data);
  });

  it('throws away a file that fails its checksum, and never loads it', async () => {
    const { asset, data } = fakeAsset();
    const bad = Buffer.from(data);
    bad[500] = bad[500]! ^ 0xff;
    const dir = tempDir();
    const d = new ModelDownloader({ dir, asset, fetch: server(data, { body: bad }).fetch, retryDelaysMs: [] });
    await d.attempt();
    expect(d.state()).toMatchObject({ model: 'failed', detail: expect.stringContaining('checksum') });
    expect(d.state().detail).toContain('next time the app starts');
    expect(existsSync(d.path)).toBe(false);
    expect(existsSync(`${d.path}.part`)).toBe(false);
  });

  it('says when it will try again after a failure', async () => {
    const { asset, data } = fakeAsset();
    const d = new ModelDownloader({ dir: tempDir(), asset, fetch: server(data, { status: 404 }).fetch, retryDelaysMs: [60_000] });
    await d.attempt();
    expect(d.state()).toEqual({ model: 'failed', detail: 'the server answered 404; trying again in 1 minute' });
    await d.stop();
  });

  it('leaves the download to another running copy of the app, and takes over a lock left behind', async () => {
    const { asset, data } = fakeAsset();
    const dir = tempDir();
    // The parent process stands in for another copy of the app that is still running.
    writeFileSync(join(dir, 'test-model.lock'), String(process.ppid));
    const srv = server(data);
    const d = new ModelDownloader({ dir, asset, fetch: srv.fetch, retryDelaysMs: [60_000] });
    await d.attempt();
    expect(srv.requests).toHaveLength(0);
    expect(d.state()).toMatchObject({ model: 'downloading', detail: expect.stringContaining('another copy') });
    await d.stop();

    // A lock whose process has gone is taken over.
    writeFileSync(join(dir, 'test-model.lock'), '999999999');
    const next = new ModelDownloader({ dir, asset, fetch: srv.fetch, retryDelaysMs: [] });
    await next.attempt();
    expect(next.state().model).toBe('ready');
  });

  it('trusts a file from an earlier run only after checking it again', async () => {
    const { asset, data } = fakeAsset();
    const dir = tempDir();
    const good = new ModelDownloader({ dir, asset, fetch: server(data).fetch, retryDelaysMs: [] });
    await good.attempt();

    const srv = server(data);
    const later = new ModelDownloader({ dir, asset, fetch: srv.fetch, startDelayMs: 60_000 });
    later.start();
    expect(later.state().model).toBe('ready');
    expect(srv.requests).toHaveLength(0);
    await later.stop();

    writeFileSync(later.path, 'damaged');
    const damaged = new ModelDownloader({ dir, asset, fetch: srv.fetch, startDelayMs: 60_000 });
    damaged.start();
    expect(damaged.state().model).toBe('missing');
    expect(existsSync(damaged.path)).toBe(false);
    await damaged.stop();
  });
});

/** A side that answers fixed moves, or fails, and counts its calls. */
function side(name: TemptingMovesPort['name'], answer: string[] | Error) {
  const s = {
    name,
    calls: 0,
    async suggest() {
      s.calls++;
      if (answer instanceof Error) throw answer;
      return { moves: answer };
    },
  };
  return s;
}

describe('choosing where the tempting moves come from', () => {
  const req = { startFen: INITIAL_FEN, moves: [] };

  async function readyDownloader() {
    const { asset, data } = fakeAsset();
    const d = new ModelDownloader({ dir: tempDir(), asset, fetch: server(data).fetch, retryDelaysMs: [] });
    await d.attempt();
    return d;
  }

  it('asks Opus until the model is downloaded, then Maia-3, with no restart', async () => {
    const { asset, data } = fakeAsset();
    const downloader = new ModelDownloader({ dir: tempDir(), asset, fetch: server(data).fetch, retryDelaysMs: [] });
    const maia = side('maia', ['e2e4']);
    const opus = side('opus', ['d2d4']);
    const service = new TemptingMovesService({ local: { downloader, load: async () => maia }, fallback: opus });
    expect(await service.suggest(req)).toMatchObject({ moves: ['d2d4'], source: 'opus' });
    expect(service.status()).toMatchObject({ source: 'opus', model: 'missing' });

    await downloader.attempt();
    expect(await service.suggest(req)).toMatchObject({ moves: ['e2e4'], source: 'maia' });
    expect(service.status()).toMatchObject({ source: 'maia', model: 'ready' });
    expect(opus.calls).toBe(1);
  });

  it('switches Maia-3 off until the app restarts after it fails, and Opus answers', async () => {
    const maia = side('maia', new Error('the runtime crashed'));
    const opus = side('opus', ['d2d4']);
    const service = new TemptingMovesService({ local: { downloader: await readyDownloader(), load: async () => maia }, fallback: opus });
    expect(await service.suggest(req)).toMatchObject({ moves: ['d2d4'], source: 'opus' });
    expect(await service.suggest(req)).toMatchObject({ moves: ['d2d4'], source: 'opus' });
    expect(maia.calls).toBe(1);
    expect(service.status()).toMatchObject({ source: 'opus', model: 'failed', detail: expect.stringContaining('the runtime crashed') });
  });

  it('falls back to Opus when the model file fails to load', async () => {
    const opus = side('opus', ['d2d4']);
    const service = new TemptingMovesService({
      local: { downloader: await readyDownloader(), load: () => Promise.reject(new Error('not a model')) },
      fallback: opus,
    });
    expect(await service.suggest(req)).toMatchObject({ moves: ['d2d4'], source: 'opus' });
    expect(service.status().detail).toContain('not a model');
  });

  it('gives no moves rather than an error when the fallback fails too', async () => {
    const lines: string[] = [];
    const service = new TemptingMovesService({ fallback: side('opus', new Error('usage limit')), log: (l) => lines.push(l) });
    expect(await service.suggest(req)).toMatchObject({ moves: [], source: 'opus' });
    expect(lines.join('\n')).toContain('usage limit');
  });

  it('uses the fixed fake in verify mode, with no model and no network', async () => {
    const service = TemptingMovesService.fake();
    expect(service.status()).toEqual({ source: 'fake', model: 'off', detail: 'verify mode uses fixed moves' });
    expect((await service.suggest(req)).source).toBe('fake');
  });
});

describe('the fake and Opus sides', () => {
  it('gives the same moves for the same position: captures, then checks, and nothing quiet', async () => {
    const fake = new FakeTemptingMoves();
    expect((await fake.suggest({ startFen: INITIAL_FEN, moves: [] })).moves).toEqual([]);
    // After 1. e4 e5 2. Qh5 Nc6, Qxe5+ and Qxf7+ take a pawn with check; Qxh7 takes one too.
    expect((await fake.suggest({ startFen: INITIAL_FEN, moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6'] })).moves).toEqual(['h5e5', 'h5f7', 'h5h7']);
    // After 1. e4 d5, exd5 is the only capture.
    expect((await fake.suggest({ startFen: INITIAL_FEN, moves: ['e2e4', 'd7d5'], count: 1 })).moves).toEqual(['e4d5']);
  });

  it("asks Opus with the research's instinct prompt, which says nothing of the player's level", () => {
    const prompt = instinctPrompt(INITIAL_FEN, ['e2e4', 'e7e5', 'g1f3'], 3);
    expect(prompt).toContain('FEN: rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
    expect(prompt).toContain('The last moves were: 1. e4 e5 2. Nf3');
    expect(prompt).toContain('on instinct, without calculating');
    expect(prompt).not.toMatch(/rating|elo|beginner|level/i);
  });

  it('keeps only legal moves from Opus, as UCI, and keeps connectors out of the call', async () => {
    let sent: Options | undefined;
    const fakeQuery = (({ options }: { options?: Options }) => {
      sent = options;
      return (async function* () {
        yield {
          type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.015,
          usage: { input_tokens: 1500, output_tokens: 300 }, modelUsage: { 'claude-opus-5-5': {} },
          structured_output: { moves: ['Nf3', 'Ke2', '1. e4', 'Qh5', 'Nf3'] },
        };
      })();
    }) as unknown as typeof query;
    const { moves, usage } = await new OpusTemptingMoves({ query: fakeQuery }).suggest({ startFen: INITIAL_FEN, moves: [] });
    expect(moves).toEqual(['g1f3', 'e2e4']);
    // What the guess cost, for the Coach call log.
    expect(usage).toMatchObject({ inputTokens: 1500, outputTokens: 300, costUsd: 0.015, models: ['claude-opus-5-5'] });
    expect(sent).toMatchObject({ model: 'opus', tools: [], mcpServers: {}, settingSources: [], persistSession: false });
    expect(sent?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(sent?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(OPUS_OUTPUT_TOKENS));
    expect(sent?.env?.PATH).toBe(process.env.PATH);
    expect(legalOnly(INITIAL_FEN, ['O-O', 42, 'e2e4'], 3)).toEqual(['e2e4']);
  });
});

describe('the Opus side, when it is slow or a Review shares one signal', () => {
  it('gives up after its deadline, so the Coach answers without tempting moves', async () => {
    // A call that never answers.
    const stuck = (() => (async function* () {
      await new Promise(() => {});
      yield { type: 'result' };
    })()) as unknown as typeof query;
    const started = Date.now();
    expect(await new OpusTemptingMoves({ query: stuck, deadlineMs: 50 }).suggest({ startFen: INITIAL_FEN, moves: [] })).toEqual({ moves: [] });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("removes its listener from the caller's signal once each guess is done", async () => {
    const done = (() => (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, structured_output: { moves: ['e4'] } };
    })()) as unknown as typeof query;
    const review = new AbortController();
    const opus = new OpusTemptingMoves({ query: done });
    for (let i = 0; i < 3; i++) await opus.suggest({ startFen: INITIAL_FEN, moves: [], signal: review.signal });
    expect(getEventListeners(review.signal, 'abort')).toHaveLength(0);
  });
});

describe('what the desktop reports', () => {
  it('says where the tempting moves come from in hello, which coachctl doctor shows', async () => {
    const app = await instance();
    const hello = await (await client(app)).request('hello', { client: 'test' });
    expect(hello.temptingMoves).toEqual({ source: 'fake', model: 'off', detail: 'verify mode uses fixed moves' });
  });
});

// ---------- Part B: the tempting moves in Coach calls ----------

describe('the rating Maia-3 is given', () => {
  it('prefers the blitz rating, converts only the pools that convert soundly, and gives 1500 otherwise', () => {
    // Blitz first: Lichess as it is, chess.com by the ChessGoals blitz table.
    expect(maiaRating({ rating: 1800, site: 'lichess', pool: 'rapid', blitz: 1600 })).toBe(1600);
    expect(maiaRating({ rating: 1488, site: 'chesscom', pool: 'chess_rapid', blitz: 1390 })).toBe(1681);
    // No blitz: Lichess rapid as it is, chess.com rapid by the ChessGoals rapid table.
    expect(maiaRating({ rating: 1432, site: 'lichess', pool: 'rapid' })).toBe(1432);
    expect(maiaRating({ rating: 1500, site: 'chesscom', pool: 'chess_rapid' })).toBe(1620);
    expect(maiaRating({ rating: 1000, site: 'chesscom', pool: 'chess_rapid' })).toBe(1229);
    expect(maiaRating({ rating: 600, site: 'chesscom', pool: 'chess_rapid' })).toBe(875);
    expect(maiaRating({ rating: 2500, site: 'chesscom', pool: 'chess_rapid' })).toBe(2815);
    // Pools with no sound conversion, and a rating linked before its pool was recorded: 1500.
    expect(maiaRating({ rating: 1900, site: 'lichess', pool: 'classical' })).toBe(1500);
    expect(maiaRating({ rating: 1900, site: 'lichess', pool: 'correspondence' })).toBe(1500);
    expect(maiaRating({ rating: 1300, site: 'chesscom', pool: 'chess_daily' })).toBe(1500);
    expect(maiaRating({ rating: 1300, site: 'chesscom', pool: 'chess_bullet' })).toBe(1500);
    expect(maiaRating({ rating: 1700, site: 'lichess', pool: null })).toBe(1500);
    expect(maiaRating({ rating: null })).toBe(1500);
  });

  it('records the pool and the blitz rating when the Player links an account', async () => {
    const app = await instance();
    const c = await client(app);
    // The recorded Lichess player has played rapid, not blitz; the chess.com one has both.
    await c.request('profile.update', { rating: { site: 'lichess', username: 'CoachVerify' } });
    expect(rows(app, 'SELECT pool, blitz FROM rating_pools')).toEqual([{ pool: 'rapid', blitz: null }]);
    expect(playerMaiaRating(app.app.db)).toBe(1612);
    const profile = await c.request('profile.update', { rating: { site: 'chesscom', username: 'coachverify' } });
    expect(profile.rating).toBe(1488);
    expect(rows(app, 'SELECT pool, blitz FROM rating_pools')).toEqual([{ pool: 'chess_rapid', blitz: 1390 }]);
    expect(playerMaiaRating(app.app.db)).toBe(1681);
    await c.request('profile.update', { rating: null });
    expect(playerMaiaRating(app.app.db)).toBe(1500);
  });
});

describe("the game Maia-3 reads, from a client's moves", () => {
  it('is the game from its start when the moves lead to the position, and the position alone otherwise', () => {
    const fen = gamePositions(INITIAL_FEN, ['e2e4', 'e7e5']).at(-1)!;
    expect(historyFromSans(fen, ['e4', 'e5'])).toEqual({ startFen: INITIAL_FEN, moves: ['e2e4', 'e7e5'] });
    // A position set up by hand, or moves that lead elsewhere, or that aren't moves at all.
    expect(historyFromSans(fen, [])).toEqual({ startFen: fen, moves: [] });
    expect(historyFromSans(fen, ['d4', 'd5'])).toEqual({ startFen: fen, moves: [] });
    expect(historyFromSans(fen, ['e4', 42])).toEqual({ startFen: fen, moves: [] });
  });
});

// After 1. e4 e5 2. Qh5 Nc6, White to move: the fake suggests Qxe5+, Qxf7+ and Qxh7.
const QH5 = { job: 'why' as const, fen: gamePositions(INITIAL_FEN, ['e2e4', 'e7e5', 'd1h5', 'b8c6']).at(-1)!, recentMoves: ['e4', 'e5', 'Qh5', 'Nc6'], playerSide: 'white' as const };

describe('the tempting moves in the brief', () => {
  it('are graded by the Engine, marked on its candidates and listed after them when it didn\'t list them', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('coach.ask', { ...QH5, question: 'What should I play?' });
    const brief = app.coach.lastBrief!;
    const all = [...brief.candidates.filter((x) => x.tempting), ...(brief.tempting ?? [])];
    expect(all.map((t) => t.san).sort()).toEqual(['Qxe5+', 'Qxf7+', 'Qxh7']);
    // Each one the Engine didn't list has its Move Grade, its line and what it does.
    for (const t of brief.tempting ?? []) {
      expect(brief.candidates.some((x) => x.uci === t.uci)).toBe(false);
      expect(t).toMatchObject({ grade: expect.any(String), line: expect.any(String), evaluation: expect.any(String) });
    }
    // Qxf7+ gives the queen away: a Blunder, which the fake Coach names as a trap.
    expect(all.find((t) => t.san === 'Qxf7+')?.grade).toBe('Blunder');
  });

  it("marks the move itself when it's one many players reach for", async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('coach.ask', { ...QH5, moveUci: 'h5f7' });
    expect(app.coach.lastBrief?.move).toMatchObject({ san: 'Qxf7+', tempting: true });
    expect((app.coach.lastBrief?.tempting ?? []).map((t) => t.san)).not.toContain('Qxf7+');
  });

  it('go to Why Questions, Review moments and Hints, never to Live Coaching or Lesson turns', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('coach.ask', { ...QH5, job: 'hint' });
    await c.request('coach.ask', { ...QH5, job: 'live', moveUci: 'h5f7' });
    expect(app.coach.lastBrief?.tempting).toBeUndefined();
    expect(app.coach.lastBrief?.move?.tempting).toBeUndefined();
    const review = await c.request('review.start', { gameId: 1 });
    expect(review.moments.length).toBeGreaterThan(0);
    const jobs = rows<{ job: string }>(app, 'SELECT c.job FROM coach_tempting t JOIN coach_calls c ON c.id = t.call_id').map((r) => r.job);
    expect(new Set(jobs)).toEqual(new Set(['hint', 'review-moment']));
  });

  it('give a Hint only those the Engine already lists, with no search of their own', async () => {
    const app = await instance();
    const c = await client(app);
    const engine = app.app.context.desktopEngine;
    let searched = 0;
    const gradeAsked = engine.gradeAsked.bind(engine);
    engine.gradeAsked = (...args) => {
      searched++;
      return gradeAsked(...args);
    };
    await c.request('coach.ask', { ...QH5, job: 'hint' });
    expect(searched).toBe(0);
    expect(app.coach.lastBrief?.tempting).toBeUndefined();
    const [logged] = rows<{ moves: string }>(app, 'SELECT moves FROM coach_tempting');
    const listed = new Set(app.coach.lastBrief?.candidates.map((x) => x.uci));
    const marked = app.coach.lastBrief?.candidates.filter((x) => x.tempting).map((x) => x.uci) ?? [];
    expect(marked).toEqual((JSON.parse(logged!.moves) as string[]).filter((uci) => listed.has(uci)));
  });

  it("are left out when it isn't the Player's turn: they describe the Player's level", async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('coach.ask', { ...QH5, playerSide: 'black' });
    expect(app.coach.lastBrief?.tempting).toBeUndefined();
    expect(app.coach.lastBrief?.candidates.some((x) => x.tempting)).toBe(false);
    expect(rows(app, 'SELECT * FROM coach_tempting')).toEqual([]);
  });

  it('give a Hint none while only Opus could guess them: it must stay quick', async () => {
    const opus = side('opus', ['h5f7']);
    const { asset, data } = fakeAsset();
    const downloader = new ModelDownloader({ dir: tempDir(), asset, fetch: server(data, { status: 404 }).fetch, retryDelaysMs: [] });
    const app = await instance({ temptingMoves: new TemptingMovesService({ local: { downloader }, fallback: opus }) });
    const c = await client(app);
    await c.request('coach.ask', { ...QH5, job: 'hint' });
    expect(opus.calls).toBe(0);
    await c.request('coach.ask', QH5);
    expect(opus.calls).toBe(1);
  });

  it('log where they came from, and what an Opus guess cost, with each Coach call', async () => {
    const usage = { inputTokens: 1500, outputTokens: 330, cacheReadTokens: 0, cacheWriteTokens: 1500, turns: 1, ms: 8100, costUsd: 0.0148, models: ['claude-opus-5-5'] };
    const opus = { name: 'opus' as const, suggest: async () => ({ moves: ['h5f7'], usage }) };
    const app = await instance({ temptingMoves: new TemptingMovesService({ fallback: opus }) });
    const c = await client(app);
    await c.request('coach.ask', QH5);
    const [row] = rows<{ source: string; moves: string; usage: string }>(app, 'SELECT source, moves, usage FROM coach_tempting');
    expect(row).toMatchObject({ source: 'opus', moves: '["h5f7"]' });
    expect(JSON.parse(row!.usage)).toEqual(usage);
  });

  it('leave the brief within its budget, and are the first thing dropped from a full one', () => {
    const fen = QH5.fen;
    const candidate = (uci: string) => ({ uci, san: uci, score: { cp: 0 }, pv: [uci] });
    const ask = {
      job: 'why' as const, fen, recentMoves: QH5.recentMoves, candidates: [candidate('f1c4')],
      tempting: [candidate('h5f7'), candidate('h5e5'), candidate('h5h7')], question: 'x'.repeat(390),
    };
    const profile = { level: 'casual' as const, rating: null, goals: [], weaknesses: [], notes: [] };
    const brief = buildBrief({ ask, profile });
    expect(brief.tempting?.map((t) => t.uci)).toEqual(['h5f7', 'h5e5', 'h5h7']);
    expect(briefSize(brief)).toBeLessThanOrEqual(BRIEF_BUDGET);
  });
});

describe('the move guard and the tempting moves', () => {
  it('accepts a tempting move the Engine graded, names its line but never draws it, and strips a made-up move', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('coach.ask', QH5);
    const trap = (app.coach.lastBrief?.tempting ?? []).find((t) => t.line);
    expect(trap).toBeDefined();
    const reply = buildBriefReply(app.coach.lastBrief!, trap!);
    expect(reply.moves).toEqual(expect.arrayContaining([trap!.uci]));
    expect(reply.arrows.map((a) => `${a.from}${a.to}`)).toEqual([trap!.uci]);
    expect(reply.stripped).toEqual(["move a2a3 is not in the Engine's output", `arrow ${reply.lineMove} is not in the Engine's output`]);
  });
});

/** Runs the guard on a reply that shows a tempting move, the first move of its line (also as an arrow), and a made-up move. */
function buildBriefReply(brief: Brief, trap: BriefCandidate) {
  const afterTrap = playUci(brief.fen, trap.uci)!.fenAfter;
  const lineMove = playSan(afterTrap, trap.line.split(' ')[0]!)!.uci;
  const guarded = guardReply(brief, {
    text: 'x', moves: [trap.uci, lineMove, 'a2a3'], arrows: [{ uci: trap.uci, brush: 'red' }, { uci: lineMove, brush: 'yellow' }], highlights: [], note: null,
  });
  return { ...guarded, lineMove };
}
