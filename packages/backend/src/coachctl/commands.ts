// The coachctl commands. Each resolves an instance (a verify-mode run, or --url and --token),
// talks to it over the same HTTP and WebSocket protocol as the web app, and returns JSON.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { INITIAL_FEN, outcomeOf, outcomeOfLine, playSan, playUci, turnOf, type PlayedMove, type Side } from '@chess-coach/shared/chess';
import type { EngineConfig } from '../server.ts';
import { CoachClient, pairDevice, ProtocolError } from '../client.ts';
import { defaultDataDir } from '../paths.ts';
import { appVersion } from '../runtime.ts';
import { evidenceRoot, isAlive, listRuns, readRun, runFilePath, stateDir, writeRun, type RunFile } from '../verify/runs.ts';

type Flags = Record<string, string | true>;
export type Result = Record<string, unknown> & { ok: boolean };

export class CtlError extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.fix = fix;
  }
}

export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface Target {
  url: string;
  token?: string;
  run?: RunFile;
  runFile?: string;
}

const START_FIX = 'Start one with: npm run verify';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** The instance a command acts on: --url/--token, --run, or the newest running verify-mode run. */
function target(flags: Flags, options: { allowOwner?: boolean } = {}): Target {
  const url = str(flags, 'url');
  if (url) return { url: url.replace(/\/$/, ''), ...(str(flags, 'token') ? { token: str(flags, 'token') as string } : {}) };
  const state = stateDir(flags['state-dir']);
  const runId = str(flags, 'run');
  if (runId) {
    const runFile = runFilePath(state, runId);
    const run = readRun(runFile);
    if (!run) throw new CtlError(`No verify-mode run called ${runId} in ${state}.`, 'List runs with: ls .verify/runs, or start one with: npm run verify');
    return { url: run.url, token: run.token, run, runFile };
  }
  const running = listRuns(state).filter((r) => r.status === 'ready' && isAlive(r.pid));
  const run = running.at(-1);
  if (run) return { url: run.url, token: run.token, run, runFile: runFilePath(state, run.runId) };
  if (options.allowOwner) {
    const instance = join(defaultDataDir(), 'instance.json');
    if (existsSync(instance)) {
      const info = JSON.parse(readFileSync(instance, 'utf8')) as { url: string };
      return { url: `http://127.0.0.1:${new URL(info.url).port}` };
    }
  }
  throw new CtlError('No running verify-mode instance found.', START_FIX);
}

function needToken(t: Target): string {
  if (!t.token) throw new CtlError('This command needs a device token.', 'Pass --token <token> (get one with: coachctl pair --url <url> --code <pairing code>), or use a verify-mode run.');
  return t.token;
}

async function connect(t: Target): Promise<CoachClient> {
  try {
    return await CoachClient.connect(t.url, needToken(t));
  } catch (err) {
    if (err instanceof ProtocolError) throw new CtlError(err.message, 'The token was refused. Pair again with: coachctl pair');
    throw new CtlError(`Can't reach ${t.url}.`, 'Check the instance is running with: coachctl doctor');
  }
}

async function withClient<T>(t: Target, fn: (c: CoachClient) => Promise<T>): Promise<T> {
  const client = await connect(t);
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof ProtocolError) throw new CtlError(err.message, fixFor(err.code));
    throw err;
  } finally {
    await client.close();
  }
}

function fixFor(code: string): string {
  switch (code) {
    case 'invalid-pgn':
      return 'Check the PGN has headers and a result, and that every move is legal.';
    case 'needs-side':
      return 'Pass --side white or --side black.';
    case 'not-found':
      return 'List games with: coachctl db get games';
    case 'coach-unavailable':
    case 'coach-limit':
      return 'In verify mode, reset the Coach with: coachctl coach status --ready';
    default:
      return 'Run coachctl doctor to check the instance.';
  }
}

async function verifyRoute(t: Target, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${t.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${needToken(t)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new CtlError(`Can't reach ${t.url}.`, 'Check the instance with: coachctl doctor');
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 404 && !String(body.error ?? '').includes('verify route')) {
    throw new CtlError('This instance is not in verify mode.', START_FIX);
  }
  if (!res.ok) throw new CtlError(String(body.error ?? `HTTP ${res.status}`), 'Check the command options with --help.');
  return body;
}

async function engineConfig(t: Target): Promise<EngineConfig> {
  const res = await fetch(`${t.url}/api/config`);
  return ((await res.json()) as { engine: EngineConfig }).engine;
}

async function nodeEngine() {
  const { createNodeEngine } = await import('../engine/node-engine.ts');
  return createNodeEngine();
}

/** Accepts SAN or UCI. */
function parseMove(fen: string, text: string) {
  return playUci(fen, text) ?? playSan(fen, text);
}

// ---------- doctor ----------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function doctor(flags: Flags): Promise<Result> {
  const t = target(flags, { allowOwner: true });
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => checks.push({ name, ok, detail, ...(ok || !fix ? {} : { fix }) });

  if (t.run) {
    const alive = t.run.pid > 0 && isAlive(t.run.pid);
    add('process', alive && t.run.status === 'ready', `run ${t.run.runId}: status ${t.run.status}, pid ${t.run.pid} ${alive ? 'running' : 'not running'}`, t.run.status === 'stopped' ? 'This run was cleaned up. Start a fresh one with: npm run verify' : `Clean up with: coachctl cleanup --run ${t.run.runId}, then: npm run verify`);
  }
  let health: { ok?: boolean; version?: string; verify?: boolean; pid?: number } | undefined;
  try {
    const res = await fetch(`${t.url}/api/health`, { signal: AbortSignal.timeout(3000) });
    health = (await res.json()) as typeof health;
    add('backend', Boolean(health?.ok), `${t.url}/api/health answered`, START_FIX);
  } catch {
    add('backend', false, `${t.url} did not answer`, t.run ? (t.run.status === 'stopped' ? 'This run was cleaned up. Start a fresh one with: npm run verify' : `The backend is down. Run: coachctl cleanup --run ${t.run.runId}, then: npm run verify`) : 'Start the app with: npx openchesscoach@latest (or npm start in a copy of the repository)');
  }
  if (health) {
    if (t.run) add('port-owner', health.pid === t.run.pid, `port ${new URL(t.url).port} is served by pid ${health.pid ?? 'unknown'}`, 'Another process holds this port. Start a fresh run with: npm run verify');
    const expected = appVersion();
    add('version', health.version === expected, `instance ${health.version}, coachctl ${expected}`, 'Rebuild and restart the instance so both come from the same build.');
    add('mode', t.run ? health.verify === true : true, health.verify ? 'verify mode' : 'normal mode', 'This run is not in verify mode. Start one with: npm run verify');
    try {
      const page = await (await fetch(`${t.url}/`)).text();
      add('web-app', page.includes('id="app"'), 'the web app is served', 'Build the web app: npm run build -w @chess-coach/web');
    } catch {
      add('web-app', false, 'the web app could not be fetched', 'Build the web app: npm run build -w @chess-coach/web');
    }
    try {
      await CoachClient.connect(t.url, 'not-a-token').then((c) => c.close());
      add('pairing-guard', false, 'a connection without a valid token was accepted', 'Pairing is broken: see ADR 0001 and src/server.ts.');
    } catch (err) {
      add('pairing-guard', err instanceof ProtocolError, 'a connection without a valid token is refused');
    }
    if (t.token) {
      try {
        const client = await CoachClient.connect(t.url, t.token);
        const hello = await client.request('hello', { client: 'coachctl-doctor' });
        await client.close();
        add('pairing', true, `paired device ${hello.deviceId} connected; Coach ${hello.coach.state}`);
        // Where the moves a Player would reach for come from (ADR 0011). Until the Maia-3 model is
        // ready Opus answers, so only a failed download is a problem worth fixing.
        const tempting = hello.temptingMoves;
        add(
          'tempting-moves',
          tempting.model !== 'failed',
          `from ${tempting.source}; Maia-3 model ${tempting.model}: ${tempting.detail}`,
          'Check this desktop can reach github.com, then restart the app to download the model again.',
        );
        if (t.run) {
          const engine = await engineConfig(t);
          add('engine', engine.singleThread && engine.depth === 10, `depth ${engine.depth}, ${engine.multiPv} lines, ${engine.singleThread ? 'one thread' : 'several threads'}`, 'Verify mode should fix the Engine at depth 10 on one thread.');
        }
      } catch (err) {
        add('pairing', false, err instanceof Error ? err.message : String(err), 'Pair again with: coachctl pair');
      }
    } else {
      add('pairing', true, 'skipped: no device token for this instance (pass --token to check it)');
    }
  }
  const healthy = checks.every((c) => c.ok);
  return { ok: healthy, healthy, url: t.url, ...(t.run ? { runId: t.run.runId } : {}), checks };
}

// ---------- pair ----------

async function pair(flags: Flags): Promise<Result> {
  const t = target(flags);
  const code = str(flags, 'code') ?? t.run?.code;
  if (!code) throw new CtlError('No pairing code.', 'Pass --code <code> as shown by the desktop.');
  try {
    const token = await pairDevice(t.url, code, str(flags, 'name') ?? 'coachctl');
    return { ok: true, url: t.url, token };
  } catch (err) {
    throw new CtlError(err instanceof Error ? err.message : String(err), 'Use the current pairing code. In verify mode it is in the run file and in npm run verify\'s output.');
  }
}

// ---------- play ----------

const LEVELS: Record<number, number> = { 1: 4, 2: 6, 3: 9, 4: 12 };

async function play(flags: Flags): Promise<Result> {
  const t = target(flags);
  const side = (str(flags, 'side') ?? 'white') as Side;
  if (side !== 'white' && side !== 'black') throw new CtlError(`Unknown side ${side}.`, 'Use --side white or --side black.');
  const strength = Number(str(flags, 'strength') ?? 2);
  if (!LEVELS[strength]) throw new CtlError(`Unknown strength ${strength}.`, 'Use --strength 1, 2, 3 or 4.');
  const moves = (str(flags, 'moves') ?? '').split(/[\s,]+/).filter(Boolean);
  const engine = await nodeEngine();
  const config = await engineConfig(t);
  const played: { ply: number; by: 'player' | 'engine'; san: string; uci: string; grade?: string }[] = [];
  let fen = INITIAL_FEN;
  const ucis: string[] = [];
  const line: PlayedMove[] = [];
  // As the Engine Game judges it: the final position, or a third occurrence of it.
  const ended = () => outcomeOfLine(INITIAL_FEN, line);
  const engineTurn = async () => {
    const uci = await engine.bestMove(fen, { skill: 20, depth: LEVELS[strength] as number, history: { startFen: INITIAL_FEN, moves: [...ucis] } });
    const m = playUci(fen, uci) as NonNullable<ReturnType<typeof playUci>>;
    ucis.push(m.uci);
    line.push(m);
    played.push({ ply: ucis.length, by: 'engine', san: m.san, uci: m.uci });
    fen = m.fenAfter;
  };
  try {
    if (side === 'black') await engineTurn();
    for (const text of moves) {
      if (ended()) break;
      const m = parseMove(fen, text);
      if (!m) throw new CtlError(`${text} is not legal in ${fen}.`, 'Give your moves in SAN (Nf3) or UCI (g1f3), in order.');
      const before = await engine.analyse(fen, { depth: config.depth, multiPv: config.multiPv });
      const after = outcomeOf(m.fenAfter) ? undefined : await engine.analyse(m.fenAfter, { depth: config.depth, multiPv: config.multiPv });
      const { gradeFromAnalyses } = await import('@chess-coach/shared/analysis');
      const g = gradeFromAnalyses(ucis.length + 1, m.uci, before, after, { startFen: INITIAL_FEN, moves: line });
      ucis.push(m.uci);
      line.push(m);
      played.push({ ply: ucis.length, by: 'player', san: m.san, uci: m.uci, grade: g.grade });
      fen = m.fenAfter;
      if (!ended()) await engineTurn();
    }
  } finally {
    engine.dispose();
  }
  const end = ended();
  let saved: unknown;
  if (end || flags.resign) {
    const result = end
      ? end.winner === 'white' ? '1-0' : end.winner === 'black' ? '0-1' : '1/2-1/2'
      : side === 'white' ? '0-1' : '1-0';
    const now = new Date().toISOString();
    saved = await withClient(t, (c) =>
      c.request('games.saveEngineGame', {
        game: {
          clientId: `coachctl-${Date.now()}`,
          playerSide: side,
          strength,
          moves: ucis,
          result,
          termination: end ? end.reason : 'resignation',
          startedAt: now,
          finishedAt: now,
        },
      }),
    );
  }
  return { ok: true, side, strength, moves: played, fen, toMove: turnOf(fen), ...(end ? { outcome: end } : {}), ...(saved ? { saved } : {}) };
}

// ---------- import-pgn ----------

async function importPgn(flags: Flags): Promise<Result> {
  const t = target(flags);
  const file = str(flags, 'file');
  const pgn = file ? readFileSync(resolve(file), 'utf8') : str(flags, 'pgn');
  if (!pgn) throw new CtlError('No PGN given.', 'Pass --file game.pgn or --pgn "<pgn text>".');
  const side = str(flags, 'side') as Side | undefined;
  const r = await withClient(t, (c) => c.request('games.importPgn', { pgn, ...(side ? { playerSide: side } : {}) }));
  return { ok: true, ...r };
}

// ---------- review ----------

async function review(flags: Flags): Promise<Result> {
  const t = target(flags);
  const gameId = Number(str(flags, 'game'));
  if (!gameId) throw new CtlError('No game given.', 'Pass --game <id>. List games with: coachctl db get games');
  return withClient(t, async (c) => {
    const existing = (await c.request('review.get', { gameId })).review;
    if (existing) return { ok: true, reopened: true, coachCalls: 0, moments: summarise(existing.moments) };
    const parts = new Set<number>();
    let graded = 0;
    const r = await c.request('review.start', { gameId }, (_text, part) => parts.add(part ?? 0), (done) => (graded = done));
    return { ok: true, reopened: false, positionsGraded: graded, coachCalls: parts.size, moments: summarise(r.moments) };
  });
}

function summarise(moments: { ply: number; san: string; grade: string; betterOptions: { san: string; score: string }[]; explanation: string }[]) {
  return moments.map((m) => ({ ply: m.ply, san: m.san, grade: m.grade, betterOptions: m.betterOptions.map((o) => `${o.san} (${o.score})`), explanation: m.explanation }));
}

// ---------- ask-why ----------

async function askWhy(flags: Flags): Promise<Result> {
  const t = target(flags);
  const fen = str(flags, 'fen') ?? INITIAL_FEN;
  const moveText = str(flags, 'move');
  const m = moveText ? parseMove(fen, moveText) : undefined;
  if (moveText && !m) throw new CtlError(`${moveText} is not legal in ${fen}.`, 'Give the move in SAN (Nf3) or UCI (g1f3) for the --fen position.');
  const question = str(flags, 'question');
  // The desktop's Engine works out the facts; coachctl sends only the position and the move (ADR 0007).
  const ask = { job: 'why' as const, fen, recentMoves: [], ...(m ? { moveUci: m.uci } : {}), ...(question ? { question } : {}) };
  const reply = await withClient(t, (c) => c.request('coach.ask', ask));
  return { ok: true, ...(m ? { move: m.san } : {}), reply };
}

// ---------- db get ----------

async function db(flags: Flags, positional: string[]): Promise<Result> {
  if (positional[0] !== 'get' || !positional[1]) throw new CtlError('Usage: coachctl db get <table>', 'Pass a table name, for example: coachctl db get devices');
  const t = target(flags);
  const body = await verifyRoute(t, `/__verify/db?table=${encodeURIComponent(positional[1])}`);
  let rows = body.rows as Record<string, unknown>[];
  const where = str(flags, 'where');
  if (where) {
    const [key, value] = where.split('=', 2) as [string, string];
    rows = rows.filter((r) => String(r[key]) === value);
  }
  return { ok: true, table: positional[1], count: rows.length, rows };
}

// ---------- screenshot / snapshot ----------

async function openPage(t: Target, flags: Flags) {
  let chromium: (typeof import('@playwright/test'))['chromium'];
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    throw new CtlError('Playwright is not installed.', 'Run from the repository (npm install), or install it with: npm i -D @playwright/test@1.56.1');
  }
  const token = needToken(t);
  const browser = await chromium.launch();
  const width = Number(str(flags, 'width') ?? 1200);
  const height = Number(str(flags, 'height') ?? 900);
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((tok) => localStorage.setItem('chess-coach.token', tok), token);
  const route = str(flags, 'route') ?? '#/';
  await page.goto(`${t.url}/${route.startsWith('#') ? route : `#${route}`}`);
  await page.getByRole('status', { name: 'Connection' }).filter({ hasText: /connected/i }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(Number(str(flags, 'wait') ?? 500));
  return { browser, page, route };
}

function evidencePath(t: Target, flags: Flags, kind: string, ext: string, route: string): string {
  const out = str(flags, 'out');
  if (out) return resolve(out);
  const dir = t.run?.evidenceDir ?? join(evidenceRoot(), 'manual');
  mkdirSync(dir, { recursive: true });
  const slug = route.replace(/^#?\/?/, '').replace(/[^a-z0-9]+/gi, '-').replace(/-$/, '') || 'menu';
  return join(dir, `${kind}-${slug}-${Date.now()}.${ext}`);
}

async function screenshot(flags: Flags): Promise<Result> {
  const t = target(flags);
  const { browser, page, route } = await openPage(t, flags);
  try {
    const path = evidencePath(t, flags, 'screenshot', 'png', route);
    await page.screenshot({ path, fullPage: Boolean(flags['full-page']) });
    return { ok: true, route, path };
  } finally {
    await browser.close();
  }
}

async function snapshot(flags: Flags): Promise<Result> {
  const t = target(flags);
  const { browser, page, route } = await openPage(t, flags);
  try {
    const tree = await page.locator('body').ariaSnapshot();
    const path = evidencePath(t, flags, 'snapshot', 'yaml', route);
    writeFileSync(path, tree);
    return { ok: true, route, path, snapshot: tree };
  } finally {
    await browser.close();
  }
}

// ---------- coach / clock ----------

async function coach(flags: Flags, positional: string[]): Promise<Result> {
  const t = target(flags);
  if (positional[0] === 'status') {
    const unavailable = str(flags, 'unavailable');
    if (!unavailable && !flags.ready) throw new CtlError('Say which status.', 'Pass --unavailable "<reason>" or --ready.');
    const status = await verifyRoute(t, '/__verify/coach/status', { method: 'POST', body: JSON.stringify({ unavailable: flags.ready ? null : unavailable }) });
    return { ok: true, status };
  }
  if (positional[0] === 'script') {
    let body: unknown;
    if (flags.clear) body = { kind: 'clear' };
    else if (flags.limit) body = { kind: 'limit' };
    else if (flags.unavailable) body = { kind: 'unavailable' };
    else if (str(flags, 'reply')) {
      try {
        body = { kind: 'reply', reply: JSON.parse(str(flags, 'reply') as string) as unknown };
      } catch {
        throw new CtlError('--reply is not valid JSON.', `Pass a JSON object, for example: --reply '{"text":"…","moves":["e2e4"]}'`);
      }
    } else throw new CtlError('Say what to script.', 'Pass --reply <json>, --limit, --unavailable or --clear.');
    await verifyRoute(t, '/__verify/coach/script', { method: 'POST', body: JSON.stringify(body) });
    return { ok: true, scripted: body };
  }
  throw new CtlError('Usage: coachctl coach script|status [options]', 'See: coachctl coach --help');
}

async function clock(flags: Flags): Promise<Result> {
  const t = target(flags);
  const set = str(flags, 'set');
  const advance = str(flags, 'advance');
  if (!set && !advance) throw new CtlError('Say how to move the clock.', 'Pass --set <ISO time> or --advance <milliseconds>.');
  const body = await verifyRoute(t, '/__verify/clock', { method: 'POST', body: JSON.stringify({ ...(set ? { set } : {}), ...(advance ? { advanceMs: Number(advance) } : {}) }) });
  return { ok: true, ...body };
}

// ---------- cleanup ----------

function commandLine(pid: number): string {
  try {
    if (existsSync(`/proc/${pid}/cmdline`)) return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function cleanup(flags: Flags): Promise<Result> {
  const state = stateDir(flags['state-dir']);
  const runId = str(flags, 'run');
  const runs = runId ? listRuns(state).filter((r) => r.runId === runId) : listRuns(state).filter((r) => r.status !== 'stopped' || existsSync(r.dataDir));
  if (runId && runs.length === 0) throw new CtlError(`No run called ${runId}.`, 'List runs with: ls .verify/runs');
  const dryRun = Boolean(flags['dry-run']);
  const actions: { runId: string; stop?: number; deleteData?: string; keepEvidence: string; skipped?: string }[] = [];
  for (const run of runs) {
    const action: (typeof actions)[number] = { runId: run.runId, keepEvidence: run.evidenceDir };
    if (run.pid > 0 && isAlive(run.pid)) {
      // Only a process this run started: its command line names this run's file.
      if (commandLine(run.pid).includes(run.runId)) action.stop = run.pid;
      else action.skipped = `pid ${run.pid} is not this run's process, so it was left alone`;
    }
    const tmp = resolve(tmpdir());
    if (existsSync(run.dataDir) && resolve(run.dataDir).startsWith(tmp) && basename(run.dataDir).includes(run.runId)) action.deleteData = run.dataDir;
    actions.push(action);
    if (dryRun) continue;
    if (action.stop) {
      process.kill(action.stop, 'SIGTERM');
      const deadline = Date.now() + 5000;
      while (isAlive(action.stop) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (isAlive(action.stop)) process.kill(action.stop, 'SIGKILL');
    }
    if (action.deleteData) rmSync(action.deleteData, { recursive: true, force: true });
    const runFile = runFilePath(state, run.runId);
    writeRun(runFile, { ...(readRun(runFile) ?? run), status: 'stopped' });
  }
  return { ok: true, dryRun, runs: actions };
}

// ---------- registry ----------

const TARGET_HELP = `
Instance:
  --run <runId>       A verify-mode run (default: the newest running one)
  --url <url>         Any instance; add --token <device token>
`;

export const commands: Record<string, { help: string; run: (flags: Flags, positional: string[]) => Promise<Result> }> = {
  doctor: {
    help: `Usage: coachctl doctor [--run <runId> | --url <url> [--token <t>]]

Read-only health check: the process is up, the port belongs to this run, the build versions
match, the web app is served, an unpaired connection is refused and a paired device connects.
With no verify-mode run it checks the owner's own instance (pairing is skipped without a token).
Prints { healthy, checks: [{ name, ok, detail, fix }] } and exits 1 when unhealthy.
${TARGET_HELP}`,
    run: doctor,
  },
  pair: {
    help: `Usage: coachctl pair [--code <pairing code>] [--name <device name>]

Pairs a new device and prints its token. In verify mode the run's code is used by default.
${TARGET_HELP}`,
    run: pair,
  },
  play: {
    help: `Usage: coachctl play --moves "e4 Nf3 Bc4" [--side white|black] [--strength 1-4] [--resign]

Plays your moves (SAN or UCI) against the Engine, which replies to each. Every move of yours
gets its Move Grade. A finished game, or one you end with --resign, is saved as an Engine Game.
${TARGET_HELP}`,
    run: play,
  },
  'import-pgn': {
    help: `Usage: coachctl import-pgn --file game.pgn | --pgn "<text>" [--side white|black]

Imports one game. --side is needed when the app can't tell which side you played.
${TARGET_HELP}`,
    run: importPgn,
  },
  review: {
    help: `Usage: coachctl review --game <id>

Starts the Review: the desktop's Engine grades every move, then the Coach explains each key
moment. A saved Review is reopened with no Coach call (coachCalls: 0).
${TARGET_HELP}`,
    run: review,
  },
  'ask-why': {
    help: `Usage: coachctl ask-why [--fen <fen>] [--move <san|uci>] [--question "<text>"]

Asks the Coach a Why Question about a move (or the position when --move is left out).
${TARGET_HELP}`,
    run: askWhy,
  },
  db: {
    help: `Usage: coachctl db get <table> [--where column=value]

Reads a table back (verify mode only). Tables: meta, devices, settings, profile, coach_notes,
grade_counts, games, graded_moves, reviews, lesson_progress, puzzle_attempts, coach_calls.
${TARGET_HELP}`,
    run: db,
  },
  screenshot: {
    help: `Usage: coachctl screenshot [--route "#/games"] [--out file.png] [--full-page] [--width 1200 --height 900] [--wait ms]

Opens the web app as a paired device and saves a screenshot to the run's evidence folder.
${TARGET_HELP}`,
    run: screenshot,
  },
  snapshot: {
    help: `Usage: coachctl snapshot [--route "#/games"] [--out file.yaml] [--wait ms]

Opens the web app as a paired device and saves its accessibility tree to the evidence folder.
${TARGET_HELP}`,
    run: snapshot,
  },
  coach: {
    help: `Usage: coachctl coach script (--reply '<json>' | --limit | --unavailable | --clear)
       coachctl coach status (--unavailable "<reason>" | --ready)

Scripts the fake Coach's next reply (for example a move the Engine never suggested) or switches
the Coach's status. Verify mode only.
${TARGET_HELP}`,
    run: coach,
  },
  clock: {
    help: `Usage: coachctl clock (--set <ISO time> | --advance <milliseconds>)

Moves the fake clock. Verify mode only.
${TARGET_HELP}`,
    run: clock,
  },
  cleanup: {
    help: `Usage: coachctl cleanup [--run <runId>] [--dry-run]

Stops verify-mode runs (only processes those runs started) and deletes their temporary data
folders. Evidence folders and run files are kept. --dry-run lists what would happen.
`,
    run: cleanup,
  },
};
