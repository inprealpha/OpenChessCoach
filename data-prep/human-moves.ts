// Research, not the app: can Claude guess the move a human plays, and at which rating band do its
// guesses fit best? Samples positions from rated Lichess games, asks Haiku, Sonnet and Opus for the
// three moves a human would most likely play (never telling them a rating), and scores each guess
// list against the move the human actually played. Stockfish, a fixed "obvious moves" rule and Maia2
// (data-prep/human-moves-maia.py) are baselines. Results: docs/research/human-move-prediction.md.
// Not part of npm test: the guess step calls real models on the owner's Claude Code login.
//
// Usage, with <dir> a working folder outside git (downloaded data is untrusted, keep it apart):
//   node data-prep/human-moves.ts sample <games.pgn> <dir> [--per-band=50] [--seed=1]
//   node data-prep/human-moves.ts guess <dir> [--models=haiku,sonnet,opus] [--effort=medium] [--concurrency=24]
//   node data-prep/human-moves.ts engine <dir>
//   <dir>/../maia/.venv/bin/python -I data-prep/human-moves-maia.py <dir>
//   node data-prep/human-moves.ts report <dir>
// Games: the first part of a monthly file from https://database.lichess.org (CC0), for example
//   curl -r 0-120000000 <url>.pgn.zst | zstd -dc > games.pgn
// Every step is resumable: guesses are appended to <dir>/guesses.jsonl and finished ones are skipped.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parsePgnGames } from '@chess-coach/shared/pgn';
import { isCheck, legalMoves, piecesOf, playSan, playUci, sanLine, turnOf, uciToSan } from '@chess-coach/shared/chess';
import { checkClaude, isWindowsShim } from '../packages/backend/src/claude-check.ts';
import { createNodeEngine } from '../packages/backend/src/engine/node-engine.ts';

export const BANDS = [
  { id: 'u1200', label: 'under 1200', min: 0, max: 1200 },
  { id: '1200-1600', label: '1200–1599', min: 1200, max: 1600 },
  { id: '1600-2000', label: '1600–1999', min: 1600, max: 2000 },
  { id: '2000+', label: '2000 and up', min: 2000, max: 4000 },
] as const;
type BandId = (typeof BANDS)[number]['id'];
type Phase = 'opening' | 'middlegame' | 'endgame';
const PHASES: Phase[] = ['opening', 'middlegame', 'endgame'];

export interface Sample {
  id: string;
  band: BandId;
  phase: Phase;
  /** The mover's and the opponent's Lichess rating; never shown to a guessing model. */
  elo: number;
  oppElo: number;
  timeControl: string;
  site: string;
  fen: string;
  /** Up to six moves before the position, in SAN, as "18. Nf3 Bd6 19. O-O". */
  recent: string;
  /** The move the human played, in UCI and SAN. */
  played: { uci: string; san: string };
  legalCount: number;
}

interface Guess {
  id: string;
  source: string;
  /** The moves as returned, then the legal ones in UCI (illegal ones dropped, order kept). */
  raw: string[];
  moves: string[];
  illegal: string[];
  modelId?: string;
  costUsd?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  ms?: number;
  error?: string;
}

const args = process.argv.slice(3);
const flag = (name: string, fallback: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const positional = args.filter((a) => !a.startsWith('--'));

/** A small seeded random number generator, so the same seed picks the same positions. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECE_VALUE: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

/** Opening: the first ten moves. Endgame: at most 13 points of pieces (not pawns) left on the board. */
function phaseOf(fen: string, ply: number): Phase {
  const pieces = piecesOf(fen).filter((p) => p.role !== 'pawn');
  const material = pieces.reduce((sum, p) => sum + PIECE_VALUE[p.role]!, 0);
  if (material <= 13) return 'endgame';
  return ply < 20 ? 'opening' : 'middlegame';
}

function bandOf(elo: number): BandId | undefined {
  return BANDS.find((b) => elo >= b.min && elo < b.max)?.id;
}

function clockSeconds(text: string): number {
  const [h, m, s] = text.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

async function sample(pgnPath: string, dir: string): Promise<void> {
  const perBand = Number(flag('per-band', '50'));
  const perPhase = Math.ceil(perBand / PHASES.length);
  const random = rng(Number(flag('seed', '1')));
  const quota = new Map<string, number>();
  const samples: Sample[] = [];
  const full = () => BANDS.every((b) => PHASES.every((p) => (quota.get(`${b.id}/${p}`) ?? 0) >= perPhase));

  let headers: Record<string, string> = {};
  let movetext: string[] = [];
  const lines = createInterface({ input: createReadStream(pgnPath) });
  for await (const line of lines) {
    if (line.startsWith('[')) {
      if (movetext.length) {
        consider(headers, movetext.join(' '));
        headers = {};
        movetext = [];
        if (full()) break;
      }
      const m = /^\[(\w+) "(.*)"\]$/.exec(line);
      if (m) headers[m[1]!] = m[2]!;
    } else if (line.trim()) movetext.push(line);
  }
  lines.close();

  function consider(h: Record<string, string>, text: string): void {
    // Rated blitz, rapid and classical games that ended normally or on time; no bullet, where moves are reflexes.
    const [base, inc] = (h.TimeControl ?? '-').split('+').map(Number);
    if (!h.Event?.startsWith('Rated') || !base || base + 40 * (inc ?? 0) < 180) return;
    if (h.Termination !== 'Normal' && h.Termination !== 'Time forfeit') return;
    const white = Number(h.WhiteElo);
    const black = Number(h.BlackElo);
    // Both players in the same band, at most 150 points apart, so the opponent is of that level too.
    const band = bandOf(white);
    if (!band || band !== bandOf(black) || Math.abs(white - black) > 150) return;
    if (random() > 0.25) return;
    const clocks = [...text.matchAll(/\[%clk (\d+:\d+:\d+)\]/g)].map((m) => clockSeconds(m[1]!));
    const game = parsePgnGames(`[Event "x"]\n\n${text.replace(/\{[^}]*\}/g, '')}`)[0];
    if (!game || game.moves.length < 16) return;
    // One position per game, after move 3, never the last move (often a resignation-time blunder).
    const ply = 6 + Math.floor(random() * (game.moves.length - 7));
    const line = [...(sanLineFrom(game.startFen, game.moves.slice(0, ply + 1)) ?? [])];
    if (line.length !== ply + 1) return;
    let fen = game.startFen;
    for (const uci of game.moves.slice(0, ply)) fen = playUci(fen, uci)!.fenAfter;
    // The mover had at least 30 seconds left, so the move was thought about, not a time scramble.
    const ownClock = ply >= 2 ? clocks[ply - 2] : base;
    if (ownClock === undefined || ownClock < 30) return;
    const legal = legalMoves(fen);
    if (legal.length < 2) return;
    const phase = phaseOf(fen, ply);
    const key = `${band}/${phase}`;
    if ((quota.get(key) ?? 0) >= perPhase) return;
    quota.set(key, (quota.get(key) ?? 0) + 1);
    const mover = turnOf(fen) === 'white' ? white : black;
    const played = playUci(fen, game.moves[ply]!)!;
    samples.push({
      id: `${band}-${phase}-${quota.get(key)}`,
      band,
      phase,
      elo: mover,
      oppElo: turnOf(fen) === 'white' ? black : white,
      timeControl: h.TimeControl!,
      site: h.Site ?? '',
      fen,
      recent: recentMoves(game.startFen, game.moves.slice(0, ply)),
      played: { uci: played.uci, san: played.san },
      legalCount: legal.length,
    });
  }

  writeFileSync(join(dir, 'samples.json'), `${JSON.stringify(samples, null, 1)}\n`);
  for (const b of BANDS) console.error(`${b.label}: ${PHASES.map((p) => `${p} ${quota.get(`${b.id}/${p}`) ?? 0}`).join(', ')}`);
  console.error(`${samples.length} positions written to ${join(dir, 'samples.json')}`);
}

function sanLineFrom(startFen: string, ucis: readonly string[]): string[] | undefined {
  try {
    return sanLine(startFen, ucis);
  } catch {
    return undefined;
  }
}

/** The last up to six moves before `ucis` ends, numbered as a scoresheet writes them. */
function recentMoves(startFen: string, ucis: readonly string[]): string {
  const from = Math.max(0, ucis.length - 6);
  let fen = startFen;
  for (const uci of ucis.slice(0, from)) fen = playUci(fen, uci)!.fenAfter;
  const parts: string[] = [];
  for (const uci of ucis.slice(from)) {
    const move = playUci(fen, uci)!;
    const number = fen.split(' ')[5];
    if (turnOf(fen) === 'white') parts.push(`${number}. ${move.san}`);
    else parts.push(parts.length ? move.san : `${number}... ${move.san}`);
    fen = move.fenAfter;
  }
  return parts.join(' ');
}

// The guessing prompt. It says the players are human and nothing about their level.
const SYSTEM_PROMPT = 'You predict the moves human chess players make in online games. Answer only with the JSON asked for.';
export function guessPrompt(s: Sample): string {
  const side = turnOf(s.fen) === 'white' ? 'White' : 'Black';
  return [
    'This position comes from a rated online game between two human players.',
    `FEN: ${s.fen}`,
    `${side} to move.`,
    s.recent ? `The last moves were: ${s.recent}` : '',
    '',
    `Which three moves is the human playing ${side} most likely to play here? Rank them, most likely first.`,
    'Predict what this person will actually play, not necessarily the best move. Give each move in SAN, like Nf3, exd5 or O-O.',
  ]
    .filter((l, i) => l || i === 4)
    .join('\n');
}
const GUESS_SCHEMA = {
  type: 'object',
  properties: { moves: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
  required: ['moves'],
  additionalProperties: false,
} as const;

/** Reads a returned move as SAN, or failing that as UCI; undefined when it is not legal here. */
export function readMove(fen: string, text: string): string | undefined {
  const clean = text.trim().replace(/^\d+\.+\s*/, '').replace(/[!?]+$/, '').replaceAll('0', 'O');
  return playSan(fen, clean)?.uci ?? playUci(fen, text.trim().toLowerCase())?.uci;
}

async function askModel(model: string, effort: string, s: Sample, claudePath: string | undefined): Promise<Guess> {
  const started = Date.now();
  const stream = query({
    prompt: guessPrompt(s),
    options: {
      model,
      effort: effort as 'low' | 'medium' | 'high',
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
      persistSession: false,
      maxTurns: 3,
      cwd: tmpdir(),
      // mcpServers: {} doesn't cover the connectors on the claude.ai account; when they load in time
      // they add about 88,000 tokens of tool definitions to a call.
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
      outputFormat: { type: 'json_schema', schema: GUESS_SCHEMA as unknown as Record<string, unknown> },
      ...(claudePath && !isWindowsShim(claudePath) ? { pathToClaudeCodeExecutable: claudePath } : {}),
    },
  });
  const guess: Guess = { id: s.id, source: model, raw: [], moves: [], illegal: [] };
  for await (const message of stream) {
    if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') throw new Error('rate limit');
    if (message.type === 'assistant' && message.error === 'rate_limit') throw new Error('rate limit');
    if (message.type === 'result') {
      guess.costUsd = message.total_cost_usd;
      guess.modelId = Object.keys(message.modelUsage ?? {}).join(',');
      const u = message.usage;
      guess.usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      if (message.subtype !== 'success' || message.is_error) guess.error = message.subtype;
      const out = (message as { structured_output?: { moves?: unknown } }).structured_output;
      if (Array.isArray(out?.moves)) guess.raw = out.moves.filter((m): m is string => typeof m === 'string');
    }
  }
  for (const text of guess.raw) {
    const uci = readMove(s.fen, text);
    if (!uci) guess.illegal.push(text);
    else if (!guess.moves.includes(uci)) guess.moves.push(uci);
  }
  guess.ms = Date.now() - started;
  return guess;
}

function readSamples(dir: string): Sample[] {
  return JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8')) as Sample[];
}

function readGuesses(dir: string): Guess[] {
  const path = join(dir, 'guesses.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Guess);
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

async function guess(dir: string): Promise<void> {
  const models = flag('models', 'haiku,sonnet,opus').split(',');
  const effort = flag('effort', 'medium');
  const concurrency = Number(flag('concurrency', '24'));
  const claude = await checkClaude();
  if (!claude.ok) throw new Error(claude.message);
  const samples = readSamples(dir);
  const done = new Set(readGuesses(dir).filter((g) => !g.error).map((g) => `${g.source}/${g.id}`));
  // Interleave models so a stop part-way leaves every model with a similar spread of positions.
  const jobs = samples.flatMap((s) => models.map((m) => ({ s, m }))).filter(({ s, m }) => !done.has(`${m}/${s.id}`));
  console.error(`${jobs.length} calls to make (${done.size} already done), ${concurrency} at a time`);
  let finished = 0;
  let limited = false;
  await pool(jobs, concurrency, async ({ s, m }) => {
    if (limited) return;
    let g: Guess;
    try {
      g = await askModel(m, effort, s, claude.path);
    } catch (err) {
      if (String(err).includes('rate limit')) limited = true;
      g = { id: s.id, source: m, raw: [], moves: [], illegal: [], error: String(err) };
    }
    appendFileSync(join(dir, 'guesses.jsonl'), `${JSON.stringify(g)}\n`);
    finished++;
    if (finished % 25 === 0 || g.error) console.error(`${finished}/${jobs.length}${g.error ? ` (${m} ${s.id}: ${g.error})` : ''}`);
  });
  if (limited) console.error('Stopped: the Claude usage limit was reached. Run again later to finish.');
}

// The free baselines: Stockfish's top five at the desktop's settings (depth 14, five lines, as the
// Coach gets them today), and a fixed "obvious moves" rule.
async function engine(dir: string): Promise<void> {
  const samples = readSamples(dir);
  const done = new Set(readGuesses(dir).map((g) => `${g.source}/${g.id}`));
  const sf = await createNodeEngine(4);
  for (const s of samples) {
    if (!done.has(`stockfish/${s.id}`)) {
      const analysis = await sf.analyse(s.fen, { multiPv: 5, depth: 14 });
      const moves = analysis.lines.map((l) => l.pv[0]!).filter(Boolean);
      appendFileSync(join(dir, 'guesses.jsonl'), `${JSON.stringify({ id: s.id, source: 'stockfish', raw: moves, moves, illegal: [] })}\n`);
    }
    if (!done.has(`obvious/${s.id}`)) {
      const moves = obviousMoves(s.fen, s.recent);
      appendFileSync(join(dir, 'guesses.jsonl'), `${JSON.stringify({ id: s.id, source: 'obvious', raw: moves, moves, illegal: [] })}\n`);
    }
  }
  console.error(`Engine and obvious-move baselines written for ${samples.length} positions`);
  process.exit(0);
}

/**
 * The "obvious moves" rule, no search: recapture on the square the opponent just captured on,
 * then other captures (biggest piece taken by the smallest first, undefended targets first), then
 * checks, then moves that attack an undefended piece, then castling; ties keep the move generator's order.
 */
export function obviousMoves(fen: string, recent: string): string[] {
  const pieces = new Map(piecesOf(fen).map((p) => [p.square, p]));
  const me = turnOf(fen);
  const lastCapture = /x([a-h][1-8])[+#]?$/.exec(recent.trim())?.[1];
  const defended = (f: string, square: string): boolean => {
    // A piece on `square` is defended if, with the side to move swapped, its own side can capture there.
    const parts = f.split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-';
    const swapped = parts.join(' ');
    try {
      return legalMoves(swapped).some((m) => m.slice(2, 4) === square);
    } catch {
      return false;
    }
  };
  const scored = legalMoves(fen).map((uci, order) => {
    const to = uci.slice(2, 4);
    const mover = pieces.get(uci.slice(0, 2));
    const target = pieces.get(to);
    const after = playUci(fen, uci)!;
    let score = 0;
    if (target && target.color !== me) {
      const gain = PIECE_VALUE[target.role]! - (defended(fen, to) ? PIECE_VALUE[mover!.role]! : 0);
      score = 1000 + (to === lastCapture ? 500 : 0) + gain * 20 + PIECE_VALUE[target.role]!;
    } else if (isCheck(after.fenAfter)) score = 600;
    else if (uci.length === 5) score = 900;
    else {
      // Does the moved piece now attack an undefended enemy piece?
      const parts = after.fenAfter.split(' ');
      parts[1] = parts[1] === 'w' ? 'b' : 'w';
      parts[3] = '-';
      let attacks: string[] = [];
      try {
        attacks = legalMoves(parts.join(' ')).filter((m) => m.slice(0, 2) === to).map((m) => m.slice(2, 4));
      } catch {
        attacks = [];
      }
      const hit = attacks.some((sq) => {
        const p = pieces.get(sq);
        return p && p.color !== me && p.role !== 'pawn' && p.role !== 'king' && !defended(after.fenAfter, sq);
      });
      if (hit) score = 400;
      else if (after.san.startsWith('O-O')) score = 300;
    }
    return { uci, score, order };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3)
    .map((m) => m.uci);
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');

/** Exact two-sided sign test (McNemar's test) for a and b discordant positions. */
export function signTest(a: number, b: number): number {
  const n = a + b;
  let tail = 0;
  let c = 1;
  for (let i = 0; i <= Math.min(a, b); i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** The p-value of a chi-square test of independence on a 4×2 table of [hits, misses] rows (3 degrees of freedom). */
export function chiSquareP(rows: readonly (readonly [number, number])[]): number {
  const total = rows.reduce((a, [h, m]) => a + h + m, 0);
  const hits = rows.reduce((a, [h]) => a + h, 0);
  let x = 0;
  for (const [h, m] of rows) {
    const n = h + m;
    for (const [observed, share] of [[h, hits / total], [m, 1 - hits / total]] as const) {
      const expected = n * share;
      if (expected > 0) x += (observed - expected) ** 2 / expected;
    }
  }
  // The chi-square survival function for 3 degrees of freedom.
  return Math.min(1, erfc(Math.sqrt(x / 2)) + Math.sqrt((2 * x) / Math.PI) * Math.exp(-x / 2));
}

function erfc(z: number): number {
  // Numerical Recipes' erfc, accurate to about 1e-7.
  const t = 1 / (1 + 0.5 * z);
  const y = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? y : 2 - y;
}

function report(dir: string): void {
  const samples = readSamples(dir);
  const byId = new Map(samples.map((s) => [s.id, s]));
  const latest = new Map<string, Guess>();
  for (const g of readGuesses(dir)) if (!g.error || !latest.has(`${g.source}/${g.id}`)) latest.set(`${g.source}/${g.id}`, g);
  const guesses = [...latest.values()].filter((g) => !g.error);
  const sources = [...new Set(guesses.map((g) => g.source))];
  const out: string[] = [];
  const hit = (g: Guess, k: number) => g.moves.slice(0, k).includes(byId.get(g.id)!.played.uci);

  out.push('## Hit rates per band (top-1 / top-3)\n');
  out.push(`| Source | ${BANDS.map((b) => b.label).join(' | ')} | All |`);
  out.push(`| --- | ${BANDS.map(() => '---').join(' | ')} | --- |`);
  const rows = [...sources, 'random'];
  for (const source of rows) {
    const cells = [...BANDS.map((b) => b.id), 'all'].map((band) => {
      const ss = samples.filter((s) => band === 'all' || s.band === band);
      if (source === 'random') {
        const t1 = ss.reduce((a, s) => a + 1 / s.legalCount, 0);
        const t3 = ss.reduce((a, s) => a + Math.min(3, s.legalCount) / s.legalCount, 0);
        return `${pct(t1, ss.length)} / ${pct(t3, ss.length)}`;
      }
      const gs = guesses.filter((g) => g.source === source && ss.some((s) => s.id === g.id));
      return `${pct(gs.filter((g) => hit(g, 1)).length, gs.length)} / ${pct(gs.filter((g) => hit(g, 3)).length, gs.length)} (n=${gs.length})`;
    });
    out.push(`| ${source} | ${cells.join(' | ')} |`);
  }

  out.push('\n## Hit rates per game phase, all bands (top-1 / top-3)\n');
  out.push(`| Source | ${PHASES.join(' | ')} |`);
  out.push(`| --- | ${PHASES.map(() => '---').join(' | ')} |`);
  for (const source of sources) {
    const cells = PHASES.map((p) => {
      const gs = guesses.filter((g) => g.source === source && byId.get(g.id)!.phase === p);
      return `${pct(gs.filter((g) => hit(g, 1)).length, gs.length)} / ${pct(gs.filter((g) => hit(g, 3)).length, gs.length)}`;
    });
    out.push(`| ${source} | ${cells.join(' | ')} |`);
  }

  out.push('\n## Illegal moves and errors\n');
  out.push('| Source | Positions answered | Moves returned | Illegal moves | Failed calls |');
  out.push('| --- | --- | --- | --- | --- |');
  const all = readGuesses(dir);
  for (const source of sources) {
    const gs = guesses.filter((g) => g.source === source);
    const failed = new Set(all.filter((g) => g.source === source && g.error).map((g) => g.id));
    const answered = new Set(gs.map((g) => g.id));
    out.push(
      `| ${source} | ${gs.length} | ${gs.reduce((a, g) => a + g.raw.length, 0)} | ${gs.reduce((a, g) => a + g.illegal.length, 0)} | ${[...failed].filter((id) => !answered.has(id)).length} |`,
    );
  }

  out.push('\n## Agreement between sources (same top-1 move / average shared moves in top 3)\n');
  out.push(`| | ${sources.join(' | ')} |`);
  out.push(`| --- | ${sources.map(() => '---').join(' | ')} |`);
  for (const a of sources) {
    const cells = sources.map((b) => {
      if (a === b) return '–';
      const pairs = samples
        .map((s) => [latest.get(`${a}/${s.id}`), latest.get(`${b}/${s.id}`)] as const)
        .filter((p): p is readonly [Guess, Guess] => !!p[0] && !!p[1] && !p[0].error && !p[1].error);
      const same = pairs.filter(([x, y]) => x.moves[0] && x.moves[0] === y.moves[0]).length;
      const shared = pairs.reduce((acc, [x, y]) => acc + x.moves.slice(0, 3).filter((m) => y.moves.slice(0, 3).includes(m)).length, 0);
      return `${pct(same, pairs.length)} / ${(shared / Math.max(1, pairs.length)).toFixed(1)}`;
    });
    out.push(`| ${a} | ${cells.join(' | ')} |`);
  }

  out.push("\n## What a model's three guesses add to the Engine's top five (the human's move is in the list)\n");
  out.push(`| List | ${BANDS.map((b) => b.label).join(' | ')} | All |`);
  out.push(`| --- | ${BANDS.map(() => '---').join(' | ')} | --- |`);
  for (const source of [undefined, ...sources.filter((s) => s !== 'stockfish' && s !== 'obvious')]) {
    const cells = [...BANDS.map((b) => b.id), 'all'].map((band) => {
      const ss = samples.filter((s) => (band === 'all' || s.band === band) && latest.get(`stockfish/${s.id}`) && (!source || latest.get(`${source}/${s.id}`)));
      const covered = ss.filter((s) => [...latest.get(`stockfish/${s.id}`)!.moves.slice(0, 5), ...(source ? latest.get(`${source}/${s.id}`)!.moves : [])].includes(s.played.uci));
      return `${pct(covered.length, ss.length)} (n=${ss.length})`;
    });
    out.push(`| ${source ? `Engine top 5 + ${source}'s 3` : 'Engine top 5 alone'} | ${cells.join(' | ')} |`);
  }

  out.push('\n## How often a model plays the engine move (top-1 equals Stockfish top-1)\n');
  for (const source of sources.filter((s) => s !== 'stockfish')) {
    const cells = BANDS.map((b) => {
      const gs = guesses.filter((g) => g.source === source && byId.get(g.id)!.band === b.id);
      const sameAsSf = gs.filter((g) => g.moves[0] && g.moves[0] === latest.get(`stockfish/${g.id}`)?.moves[0]).length;
      return `${b.label} ${pct(sameAsSf, gs.length)}`;
    });
    out.push(`- ${source}: ${cells.join(', ')}`);
  }
  const humanSf = BANDS.map((b) => {
    const ss = samples.filter((s) => s.band === b.id);
    return `${b.label} ${pct(ss.filter((s) => latest.get(`stockfish/${s.id}`)?.moves[0] === s.played.uci).length, ss.length)}`;
  });
  out.push(`- the humans themselves: ${humanSf.join(', ')}`);

  // Paired on the same positions: the positions where one source hit and the other missed.
  const both = (a: string, b: string) => samples.filter((s) => latest.get(`${a}/${s.id}`) && latest.get(`${b}/${s.id}`));
  out.push('\n## Paired comparisons (positions where only the first hit / only the second hit, exact two-sided p)\n');
  out.push('| Comparison | Top-1 | Top-3 |');
  out.push('| --- | --- | --- |');
  const models = sources.filter((s) => s !== 'stockfish' && s !== 'obvious');
  const pairs = models.flatMap((m, i) => [...models.slice(i + 1).map((n) => [m, n]), ['stockfish', m], ['obvious', m]]);
  for (const [a, b] of pairs as [string, string][]) {
    const cells = [1, 3].map((k) => {
      const ss = both(a, b);
      const only = (x: string, y: string) => ss.filter((s) => hit(latest.get(`${x}/${s.id}`)!, k) && !hit(latest.get(`${y}/${s.id}`)!, k)).length;
      const [ab, ba] = [only(a, b), only(b, a)];
      return `${ab} / ${ba} (p = ${signTest(ab, ba).toFixed(3)})`;
    });
    out.push(`| ${a} vs ${b} | ${cells.join(' | ')} |`);
  }

  out.push('\n## Does a source fit some bands better? (chi-square across the four bands, 3 degrees of freedom)\n');
  out.push('| Source | Top-1 p | Top-3 p |');
  out.push('| --- | --- | --- |');
  for (const source of sources) {
    const cells = [1, 3].map((k) => {
      const table = BANDS.map((b) => {
        const gs = guesses.filter((g) => g.source === source && byId.get(g.id)!.band === b.id);
        const hits = gs.filter((g) => hit(g, k)).length;
        return [hits, gs.length - hits] as const;
      });
      return chiSquareP(table).toFixed(3);
    });
    out.push(`| ${source} | ${cells.join(' | ')} |`);
  }

  if (models.length >= 2) {
    const ss = samples.filter((s) => models.every((m) => latest.get(`${m}/${s.id}`)));
    const firsts = ss.map((s) => models.map((m) => latest.get(`${m}/${s.id}`)!.moves[0]));
    const same = firsts.filter((f) => f[0] && f.every((m) => m === f[0])).length;
    const distinct = firsts.filter((f) => new Set(f).size === f.length).length;
    const anyTop3 = ss.filter((s) => models.some((m) => hit(latest.get(`${m}/${s.id}`)!, 3))).length;
    out.push(`\nAll of ${models.join(', ')} gave the same first move in ${same} of ${ss.length} positions (${pct(same, ss.length)}); all different first moves in ${distinct} (${pct(distinct, ss.length)}). At least one model's top 3 held the human's move in ${anyTop3} (${pct(anyTop3, ss.length)}).`);
    const outside = samples.filter((s) => latest.get(`stockfish/${s.id}`) && !latest.get(`stockfish/${s.id}`)!.moves.slice(0, 5).includes(s.played.uci));
    const caught = models.map((m) => `${m} ${outside.filter((s) => latest.get(`${m}/${s.id}`) && hit(latest.get(`${m}/${s.id}`)!, 3)).length}`);
    out.push(`\nThe human's move was outside the Engine's top 5 in ${outside.length} positions; a model's top 3 held it in: ${caught.join(', ')}.`);

    out.push('\n## Examples where every model gave a different first move\n');
    out.push(`| Position | Played | ${[...models, 'stockfish'].join(' | ')} |`);
    out.push(`| --- | --- | ${[...models, 'stockfish'].map(() => '---').join(' | ')} |`);
    const sans = (s: Sample, g: Guess) => g.moves.slice(0, 3).map((m) => uciToSan(s.fen, m)).join(', ') + (g.illegal.length ? ` (+${g.illegal.length} illegal)` : '');
    for (const s of ss.filter((_, i) => new Set(firsts[i]).size === models.length).slice(0, 10)) {
      const cells = [...models, 'stockfish'].map((m) => sans(s, latest.get(`${m}/${s.id}`)!));
      out.push(`| ${s.id} (${s.elo}), after ${s.recent} | ${s.played.san} | ${cells.join(' | ')} |`);
    }
  }

  out.push('\n## Cost and time per call\n');
  out.push('| Model | Calls | Resolved model | Avg input tokens (incl. cache) | Avg output tokens | Avg cost (USD, API prices) | Avg seconds |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const source of sources.filter((s) => guesses.some((g) => g.source === s && g.usage))) {
    const gs = guesses.filter((g) => g.source === source && g.usage);
    const avg = (f: (g: Guess) => number) => gs.reduce((a, g) => a + f(g), 0) / gs.length;
    out.push(
      `| ${source} | ${gs.length} | ${gs[0]?.modelId} | ${Math.round(avg((g) => g.usage!.input + g.usage!.cacheRead + g.usage!.cacheWrite))} | ${Math.round(avg((g) => g.usage!.output))} | ${avg((g) => g.costUsd ?? 0).toFixed(4)} | ${(avg((g) => g.ms ?? 0) / 1000).toFixed(1)} |`,
    );
  }

  const text = out.join('\n');
  writeFileSync(join(dir, 'report.md'), `${text}\n`);
  console.log(text);
}

// Run only as a script, so the scoring helpers can be imported.
const [command] = import.meta.filename === resolve(process.argv[1] ?? '') ? process.argv.slice(2) : ['import'];
if (command === 'import') {
  // Imported as a module: nothing to run.
} else if (command === 'sample') await sample(positional[0]!, positional[1]!);
else if (command === 'guess') await guess(positional[0]!);
else if (command === 'engine') await engine(positional[0]!);
else if (command === 'report') report(positional[0]!);
else {
  console.error('Usage: node data-prep/human-moves.ts sample|guess|engine|report … (see the top of this file)');
  process.exit(2);
}
