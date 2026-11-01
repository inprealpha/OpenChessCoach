// Haiku versus Sonnet for Hints and Live Coaching (#34). Balanced runs these two jobs on Haiku;
// this measures whether that is good enough. A fixed set of 15 Hint and 15 Live Coaching positions
// is asked at every Player level (beginner, casual, club), with the app's own prompt and Engine
// facts, once per model: 90 Coach calls per model. Every model gets the very same briefs, built
// once by `--facts`, so only the model differs.
//
// Opus judges read the answers apart, without knowing which model wrote them: one judge per model's
// round, and one at the end over both rounds side by side. They check every chess claim against the
// Engine at depth 18 (`--engine`), and judge from a high level whether each reply makes sense as
// coaching for a Player at that level, and whether a Hint gives its move away.
//
//   node scripts/coach-model-eval.ts --select                        rewrite scripts/coach-model-positions.json
//   node scripts/coach-model-eval.ts --facts <asks.json>             the Engine's facts for every position at every level
//   node scripts/coach-model-eval.ts --answer <asks.json> --model haiku --out <answers.json>
//   node scripts/coach-model-eval.ts --packet <answers.json> --round <n> --out <packet.json>   one round, for its judge
//   node scripts/coach-model-eval.ts --pairs <a.json> <b.json> --out <pairs.json>             both rounds, for the final judge
//   node scripts/coach-model-eval.ts --summary --round <n> <answers.json> <verdicts.json> [<final.json>]  the measured table
//   node scripts/coach-model-eval.ts --engine "<fen>" [SAN ...]      the Engine at depth 18: its best moves, and each SAN graded
//
// Hints get tempting moves from Maia-3 as an install with the model downloaded does (MAIA_MODEL, or
// the app's downloaded model file); without it they get none, as before the download. `--answer`
// spends the owner's Claude limits: one Coach call per position and level.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { INITIAL_FEN, playSan, playUci, positionKey, sanLine, sansIn, turnOf, type Side } from '../packages/shared/src/chess.ts';
import type { Brief } from '../packages/shared/src/coach/brief.ts';
import type { CoachAsk, CoachReply, CoachRequest, CoachUsage } from '../packages/shared/src/coach/types.ts';
import type { PlayerLevel } from '../packages/shared/src/protocol.ts';

const POSITIONS = new URL('coach-model-positions.json', import.meta.url);
/** The desktop's depth, as the app grades (ADR 0007). */
const ENGINE = { depth: 14, multiPv: 5 };
export const LEVELS: readonly PlayerLevel[] = ['beginner', 'casual', 'club'];
/** The Player's rating at each level, as the Player Profile would hold it: for the brief and for Maia-3. */
const LEVEL_RATING: Record<PlayerLevel, number> = { beginner: 900, casual: 1300, club: 1700 };

/** One position of the set: a Hint (the Player to move) or a Live Coaching moment (the Player's Mistake or Blunder). */
export interface ModelEvalPosition {
  id: string;
  job: 'hint' | 'live';
  /** What the position tests, for reading the results. */
  kind: 'tactic' | 'defend' | 'quiet' | 'lesson' | 'blunder' | 'mistake';
  source: string;
  fen: string;
  /** The game up to `fen`: where it started, and its SAN moves, as the screen sends them. */
  startFen: string;
  recentMoves: string[];
  playerSide: Side;
  /** Live Coaching: the Player's move, graded Mistake or Blunder at the desktop's depth. */
  moveUci?: string;
  /** A Hint during a Lesson carries the Lesson's focus (ADR 0012). */
  lessonFocus?: { lesson: string; learningGoal: string; keyIdea: string };
}

interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  gameUrl: string;
}

interface LessonFile {
  id: string;
  name: string;
  goal: string;
  parts: { fen: string; side: Side; keyIdea: string; mainLine: string[]; nodes: { ply: number; fen: string; decision: boolean }[] }[];
}

const root = new URL('../', import.meta.url);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as T;

async function select(): Promise<ModelEvalPosition[]> {
  const puzzles = [...readJson<{ puzzles: Puzzle[] }>('data/puzzles.json').puzzles, ...readJson<{ puzzles: Puzzle[] }>('data/theme-puzzles.json').puzzles].sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set<string>();
  // The unused puzzle with the theme whose rating is nearest the target, so the set spans beginner to club.
  const pick = (theme: string, rating: number): Puzzle => {
    const p = puzzles.filter((x) => !used.has(x.id) && x.themes.includes(theme)).sort((a, b) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating))[0];
    if (!p) throw new Error(`no puzzle left for ${theme}`);
    used.add(p.id);
    return p;
  };
  const after = (p: Puzzle) => playUci(p.fen, p.moves[0] as string)?.fenAfter as string;
  const setupSan = (p: Puzzle) => playUci(p.fen, p.moves[0] as string)?.san as string;

  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine } = await import('../packages/backend/src/engine/node-engine.ts');
  const { parsePgnGames } = await import('../packages/shared/src/pgn.ts');
  const engine = new EngineService(() => createNodeEngine(), ENGINE);
  const out: ModelEvalPosition[] = [];

  // Hints. Tactics to find, from puzzles across the ratings: the position after the setup move.
  const tactics: [string, number][] = [['mateIn1', 700], ['hangingPiece', 900], ['fork', 1100], ['pin', 1300], ['skewer', 1500], ['discoveredAttack', 1700], ['mateIn2', 1900]];
  for (const [theme, rating] of tactics) {
    const p = pick(theme, rating);
    out.push({ id: `hint-${theme}-${p.id}`, job: 'hint', kind: 'tactic', source: p.gameUrl, fen: after(p), startFen: p.fen, recentMoves: [setupSan(p)], playerSide: turnOf(after(p)) });
  }

  // Positions from real games: a threat to deal with, and quiet ones with no tactic in them.
  const games = parsePgnGames(readFileSync(new URL('packages/shared/test/fixtures/lichess-games.pgn', root), 'utf8'));
  const graded = [];
  for (const g of games) graded.push({ g, moves: await engine.gradeGame(g.moves, g.startFen) });
  const gameId = (g: (typeof games)[number]) => g.headers.Site?.split('/').pop() ?? 'game';
  const at = (g: (typeof games)[number], moves: Awaited<ReturnType<typeof engine.gradeGame>>, ply: number) => ({
    source: g.headers.Site ?? '',
    startFen: g.startFen ?? INITIAL_FEN,
    recentMoves: moves.slice(0, ply - 1).map((m) => m.san),
  });
  const defend: ModelEvalPosition[] = [];
  const quiet: ModelEvalPosition[] = [];
  for (const { g, moves } of graded) {
    let tookDefend = false;
    let tookQuiet = false;
    for (const m of moves) {
      if ((tookDefend || defend.length >= 3) && (tookQuiet || quiet.length >= 2)) break;
      if (m.ply < 8) continue;
      const best = m.candidates[0];
      if (!best) continue;
      const threat = await engine.threat(m.fenBefore);
      const id = `${gameId(g)}-${m.ply}`;
      if (!tookDefend && threat && defend.length < 3) {
        defend.push({ id: `hint-defend-${id}`, job: 'hint', kind: 'defend', ...at(g, moves, m.ply), fen: m.fenBefore, playerSide: m.side });
        tookDefend = true;
      } else if (!tookQuiet && !threat && quiet.length < 2 && m.ply >= 14 && !/[x+#]/.test(best.san) && best.score.cp !== undefined && Math.abs(best.score.cp) < 150) {
        quiet.push({ id: `hint-quiet-${id}`, job: 'hint', kind: 'quiet', ...at(g, moves, m.ply), fen: m.fenBefore, playerSide: m.side });
        tookQuiet = true;
      }
    }
  }
  out.push(...defend, ...quiet);

  // Hints during a Lesson: a Theme, an endgame and an opening, with the focus the Lesson screen sends.
  for (const [id, decision] of [['forks', 0], ['king-and-pawn', 0], ['italian-game', 2]] as const) {
    const lesson = readJson<LessonFile>(`data/lessons/${id}.json`);
    const part = lesson.parts[0];
    const node = part?.nodes.filter((n) => n.decision)[decision];
    if (!part || !node) throw new Error(`${id}: no such decision`);
    out.push({
      id: `hint-lesson-${id}`, job: 'hint', kind: 'lesson', source: `data/lessons/${id}.json`, fen: node.fen, startFen: part.fen,
      recentMoves: sanLine(part.fen, part.mainLine.slice(0, node.ply)), playerSide: part.side,
      lessonFocus: { lesson: lesson.name, learningGoal: lesson.goal, keyIdea: part.keyIdea },
    });
  }

  // Live Coaching. Puzzle setup moves the Engine grades a Mistake or Blunder: the Player's own move.
  const livePuzzle = async (theme: string, rating: number): Promise<ModelEvalPosition> => {
    for (;;) {
      const p = pick(theme, rating);
      const { move } = await engine.grade(p.fen, p.moves[0] as string);
      if (move.grade !== 'Mistake' && move.grade !== 'Blunder') continue;
      return { id: `live-${theme}-${p.id}`, job: 'live', kind: move.grade === 'Mistake' ? 'mistake' : 'blunder', source: p.gameUrl, fen: p.fen, startFen: p.fen, recentMoves: [], playerSide: turnOf(p.fen), moveUci: p.moves[0] as string };
    }
  };
  for (const [theme, rating] of [['fork', 800], ['hangingPiece', 1000], ['pin', 1200], ['backRankMate', 1400], ['discoveredAttack', 1600], ['skewer', 1800], ['mateIn2', 1300]] as [string, number][]) {
    out.push(await livePuzzle(theme, rating));
  }
  // And real games' Mistakes and Blunders, from the opening to the endgame, both kinds.
  const errors = graded.flatMap(({ g, moves }) => moves.filter((m) => m.grade === 'Mistake' || m.grade === 'Blunder').map((m) => ({ g, moves, m })));
  // Four Mistakes and four Blunders, one each from the opening, the middlegame and the endgame and
  // one more, each from a game and side not used yet when there is one.
  const usedSides = new Set<string>();
  const usedMoves = new Set<string>();
  const phases: [number, number][] = [[1, 20], [21, 50], [51, 999], [1, 999]];
  for (const grade of ['Mistake', 'Blunder'] as const) {
    for (const [from, to] of phases) {
      const fits = errors.filter(({ g, m }) => m.grade === grade && m.ply >= from && m.ply <= to && !usedMoves.has(`${gameId(g)}-${m.ply}`));
      const e = fits.find(({ g, m }) => !usedSides.has(`${gameId(g)}-${m.side}`)) ?? fits[0];
      if (!e) continue;
      usedSides.add(`${gameId(e.g)}-${e.m.side}`);
      usedMoves.add(`${gameId(e.g)}-${e.m.ply}`);
      out.push({ id: `live-game-${gameId(e.g)}-${e.m.ply}`, job: 'live', kind: grade === 'Mistake' ? 'mistake' : 'blunder', ...at(e.g, e.moves, e.m.ply), fen: e.m.fenBefore, playerSide: e.m.side, moveUci: e.m.uci });
    }
  }
  // The fixture games may lack one (they have no endgame Blunder): endgame puzzles make up the 15.
  while (out.filter((p) => p.job === 'live').length < 15) out.push(await livePuzzle('endgame', 1500));
  return out;
}

/** The ask the app builds for one position at one level, and the brief the Coach gets from it. */
export interface LevelAsk {
  id: string;
  level: PlayerLevel;
  ask: CoachAsk;
  brief: Brief;
}

async function facts(positions: ModelEvalPosition[]): Promise<LevelAsk[]> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { openDb } = await import('../packages/backend/src/db.ts');
  const { systemClock } = await import('../packages/backend/src/clock.ts');
  const { updateProfile } = await import('../packages/backend/src/profile.ts');
  const { CoachService } = await import('../packages/backend/src/coach/service.ts');
  const { FakeCoach } = await import('../packages/backend/src/coach/fake.ts');
  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine, desktopThreads } = await import('../packages/backend/src/engine/node-engine.ts');
  const { defaultDataDir } = await import('../packages/backend/src/paths.ts');
  const { MAIA3_5M } = await import('../packages/backend/src/tempting-moves/download.ts');
  const { MaiaTemptingMoves } = await import('../packages/backend/src/tempting-moves/maia.ts');
  const { TemptingMovesService } = await import('../packages/backend/src/tempting-moves/service.ts');
  const { guessTempting, historyFromSans, withTempting } = await import('../packages/backend/src/tempting-moves/ask.ts');
  const { playerMaiaRating } = await import('../packages/backend/src/tempting-moves/rating.ts');

  const modelPath = process.env.MAIA_MODEL ?? join(defaultDataDir(), 'models', `${MAIA3_5M.name}-${MAIA3_5M.sha256.slice(0, 8)}.onnx`);
  const maia = existsSync(modelPath) ? await MaiaTemptingMoves.load(new Uint8Array(readFileSync(modelPath)), desktopThreads()) : undefined;
  if (!maia) process.stderr.write(`No Maia-3 model at ${modelPath}: Hints get no tempting moves.\n`);
  const tempting = maia && new TemptingMovesService({ fallback: maia });

  const db = openDb(mkdtempSync(join(tmpdir(), 'coach-model-')));
  const engine = new EngineService(() => createNodeEngine(desktopThreads()), ENGINE);
  // Only for building the brief exactly as a Coach call does; no Coach is called here.
  const coach = new CoachService(db, systemClock, new FakeCoach());
  const out: LevelAsk[] = [];
  for (const level of LEVELS) {
    const rating = LEVEL_RATING[level];
    updateProfile(db, { level, rating: { site: 'lichess', username: 'eval', rating, pool: 'blitz', blitz: rating } });
    for (const p of positions) {
      const req: CoachRequest = { job: p.job, fen: p.fen, recentMoves: p.recentMoves, playerSide: p.playerSide, ...(p.moveUci ? { moveUci: p.moveUci } : {}), ...(p.lessonFocus ? { lessonFocus: p.lessonFocus } : {}) };
      const history = p.startFen === INITIAL_FEN ? historyFromSans(p.fen, p.recentMoves) : historyFromStart(p.startFen, p.recentMoves, p.fen);
      const guess = tempting && guessTempting(p.job, { service: tempting, fen: p.fen, playerSide: p.playerSide, rating: playerMaiaRating(db), history });
      const ask = await withTempting(await engine.factsFor(req), guess, engine);
      out.push({ id: p.id, level, ask, brief: coach.brief(ask) });
      process.stderr.write(`${p.id} ${level}\n`);
    }
  }
  return out;
}

/**
 * The game from a set-up position, as UCI, for Maia-3, when its moves lead to `fen`; otherwise
 * `fen` alone, as `historyFromSans` does for a game from the usual start.
 */
function historyFromStart(startFen: string, sans: readonly string[], fen: string): { startFen: string; moves: string[] } {
  let current = startFen;
  const moves: string[] = [];
  for (const san of sans) {
    const played = playSan(current, san);
    if (!played) return { startFen: fen, moves: [] };
    moves.push(played.uci);
    current = played.fenAfter;
  }
  return positionKey(current) === positionKey(fen) ? { startFen, moves } : { startFen: fen, moves: [] };
}

/** What one model said for one position at one level. */
export interface ModelAnswer {
  id: string;
  job: 'hint' | 'live';
  level: PlayerLevel;
  /** The alias asked for, and the exact model it resolved to. */
  model: string;
  resolved?: string;
  brief: Brief;
  reply?: CoachReply;
  error?: string;
  usage?: CoachUsage;
  /** The Coach call's time, from the ask to the guarded reply. The Engine's facts were built before. */
  ms: number;
  words: number;
  /** For a Hint: the moves its text names, and whether it names the square the Engine's best move goes to. */
  hint?: HintFlags;
}

export interface HintFlags {
  namesMove: string[];
  namesBestSquare: boolean;
}

/** What in a Hint's text may give the move away, for the judge to weigh: named moves, and the best move's square. */
export function hintFlags(text: string, brief: Pick<Brief, 'candidates'>): HintFlags {
  const best = brief.candidates[0];
  const to = best?.uci.slice(2, 4);
  return { namesMove: [...new Set(sansIn(text, { pushes: true }))], namesBestSquare: !!to && new RegExp(`(?<![a-wyz])${to}(?!\\d)`).test(text) };
}

async function answer(asks: LevelAsk[], model: string): Promise<ModelAnswer[]> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { openDb } = await import('../packages/backend/src/db.ts');
  const { systemClock } = await import('../packages/backend/src/clock.ts');
  const { updateProfile } = await import('../packages/backend/src/profile.ts');
  const { updateSettings } = await import('../packages/backend/src/settings.ts');
  const { CoachService } = await import('../packages/backend/src/coach/service.ts');
  const { RealCoach } = await import('../packages/backend/src/coach/real.ts');
  const { AppError } = await import('../packages/backend/src/errors.ts');

  const db = openDb(mkdtempSync(join(tmpdir(), 'coach-model-')));
  const coach = new CoachService(db, systemClock, new RealCoach());
  // The app's defaults (Think deeper on), with both jobs on the model measured.
  updateSettings(db, { models: { hint: model, live: model } });
  const out: ModelAnswer[] = [];
  for (const a of asks) {
    const rating = LEVEL_RATING[a.level];
    updateProfile(db, { level: a.level, rating: { site: 'lichess', username: 'eval', rating, pool: 'blitz', blitz: rating } });
    const brief = coach.brief(a.ask);
    if (JSON.stringify(brief) !== JSON.stringify(a.brief)) throw new Error(`${a.id} ${a.level}: the brief differs from the one --facts built`);
    const job = a.ask.job as 'hint' | 'live';
    const row: ModelAnswer = { id: a.id, job, level: a.level, model, brief, ms: 0, words: 0 };
    const last = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM coach_calls').get() as { id: number }).id;
    const started = Date.now();
    try {
      row.reply = await coach.ask(a.ask, () => {});
    } catch (err) {
      // Past the usage limit, or with the Coach unavailable, every later call would fail too: stop
      // rather than write a round that looks worse than it is.
      if (err instanceof AppError && (err.code === 'coach-limit' || err.code === 'coach-unavailable')) throw err;
      row.error = err instanceof Error ? err.message : String(err);
    }
    row.ms = Date.now() - started;
    // This call's own row: a call that failed before it was logged has none.
    const call = db.prepare('SELECT raw_reply FROM coach_calls WHERE id > ? ORDER BY id DESC LIMIT 1').get(last) as { raw_reply: string | null } | undefined;
    const usage = call?.raw_reply ? (JSON.parse(call.raw_reply) as { usage?: CoachUsage }).usage : undefined;
    if (usage) {
      row.usage = usage;
      if (usage.models[0]) row.resolved = usage.models.join(', ');
    }
    if (row.reply) {
      row.words = row.reply.text.split(/\s+/).filter(Boolean).length;
      if (job === 'hint') row.hint = hintFlags(row.reply.text, brief);
    }
    out.push(row);
    process.stderr.write(`${a.id} ${a.level}: ${row.error ?? `${row.ms} ms, ${row.words} words`}\n`);
  }
  return out;
}

/** The key an answer gets in its round's packet, by its place in the answers. */
export const keyOf = (round: string, i: number) => `${round}-${String(i + 1).padStart(3, '0')}`;

/** One answer as its judge reads it: no model name, a key instead. */
export interface JudgedAnswer {
  key: string;
  id: string;
  job: 'hint' | 'live';
  level: PlayerLevel;
  /** What the Player sees: the text, the moves drawn, and for a Hint what may give it away. */
  text: string;
  arrows: string[];
  hint?: HintFlags;
  brief: Brief;
}

/** A round's answers for its judge, with the Engine at depth 18 for each position, and the keys' answers. */
export async function packet(answers: ModelAnswer[], round: string, engineView: (fen: string, moveUci?: string) => Promise<unknown>) {
  const positions = JSON.parse(readFileSync(POSITIONS, 'utf8')) as ModelEvalPosition[];
  const engine: Record<string, unknown> = {};
  for (const p of positions) if (answers.some((a) => a.id === p.id)) engine[p.id] = await engineView(p.fen, p.moveUci);
  const judged: JudgedAnswer[] = answers.map((a, i) => ({
    key: keyOf(round, i), id: a.id, job: a.job, level: a.level,
    text: a.reply?.text ?? `(no reply: ${a.error ?? 'unknown'})`, arrows: (a.reply?.arrows ?? []).map((x) => `${x.from}${x.to} ${x.brush}`),
    ...(a.job === 'hint' && a.reply ? { hint: hintFlags(a.reply.text, a.brief) } : {}), brief: a.brief,
  }));
  return { round, engine, answers: judged };
}

/** For the judges: the Engine at depth 18, its best five moves in `fen`, each SAN graded, and after a move the best replies. */
async function engineAt18() {
  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine, desktopThreads } = await import('../packages/backend/src/engine/node-engine.ts');
  const { formatScore } = await import('../packages/shared/src/grader.ts');
  const engine = new EngineService(() => createNodeEngine(desktopThreads()), { depth: 18, multiPv: 5 });
  const lines = (fen: string, cs: { uci: string; pv: string[]; score: Parameters<typeof formatScore>[0] }[]) =>
    cs.map((c) => ({ san: playUci(fen, c.uci)?.san, evaluation: formatScore(c.score), line: sanLine(fen, c.pv.slice(0, 8)).join(' ') }));
  return async (fen: string, moveUci?: string, sans: string[] = []) => {
    const best = await engine.analyse(fen);
    const graded: unknown[] = [];
    for (const uci of [...(moveUci ? [moveUci] : []), ...sans.map((s) => playSan(fen, s)?.uci ?? s)]) {
      const after = playUci(fen, uci)?.fenAfter;
      if (!after) {
        graded.push({ move: uci, error: 'not a legal move here' });
        continue;
      }
      const { move, replies } = await engine.grade(fen, uci);
      graded.push({ san: move.san, grade: move.grade, evaluation: formatScore(move.playedScore), fenAfter: after, replies: lines(after, replies) });
    }
    const view = { fen, sideToMove: turnOf(fen), evaluationsFrom: 'the side to move', best: lines(fen, best.lines.map((l) => ({ uci: l.pv[0] as string, pv: l.pv, score: l.score }))) };
    return graded.length ? { ...view, graded } : view;
  };
}

/** Both rounds side by side for the final judge: per position and level, A and B in a fixed shuffled order. Pass rounds that don't name the model. */
export function pairs(a: { round: string; answers: JudgedAnswer[]; engine: Record<string, unknown> }, b: { round: string; answers: JudgedAnswer[] }) {
  const out = [];
  for (const x of a.answers) {
    const y = b.answers.find((z) => z.id === x.id && z.level === x.level);
    if (!y) continue;
    // A stable coin from the position and level, so the order is fixed but A is not always the same
    // round. The keys still name the rounds, so the final judge can give a verdict per round; neither
    // names the model.
    const flip = [...`${x.id}${x.level}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 === 1;
    const [first, second] = flip ? [y, x] : [x, y];
    out.push({ pair: `${x.id}|${x.level}`, keys: [first.key, second.key], id: x.id, job: x.job, level: x.level, brief: x.brief, A: { key: first.key, text: first.text, arrows: first.arrows, hint: first.hint }, B: { key: second.key, text: second.text, arrows: second.arrows, hint: second.hint } });
  }
  return { engine: a.engine, pairs: out };
}

/** A round judge's verdict on one answer. */
export interface Verdict {
  key: string;
  falseClaims: { claim: string; why: string }[];
  /** Misses the main point the moment is about. */
  missesMainPoint: boolean;
  /** A Hint that names, shows or all but names the move it should only point toward. Null for Live Coaching. */
  givesAway: boolean | null;
  /** Pitched right for the Player's level. */
  fitsLevel: boolean;
  /** As coaching, from a high level: good, ok (true but weak or vague) or poor (misleading or useless). */
  sense: 'good' | 'ok' | 'poor';
  note?: string;
}

/** The final judge's verdict on one pair: the claims it upholds, and which reply coaches better. */
export interface FinalVerdict {
  pair: string;
  /** The answers' keys, A's first, as the pairs file gives them. */
  keys: [string, string];
  /** Keys of the answers, with the false claims the final judge upholds for each (its own and the rounds'). */
  falseClaims: Record<string, string[]>;
  givesAway: Record<string, boolean> | null;
  better: 'A' | 'B' | 'tie';
  why: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? (s[(s.length - 1) / 2] as number) : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2) : 0;
};
const p90 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] as number) : 0;
};

/** The measured table for one round, per job: false claims, giveaways, sense and level, time and usage. */
export function summarize(answers: ModelAnswer[], verdicts: Verdict[], keys: string[]) {
  const byKey = new Map(verdicts.map((v) => [v.key, v]));
  const rows: Record<string, Record<string, number | string>> = {};
  for (const job of ['hint', 'live'] as const) {
    const idx = answers.map((a, i) => [a, i] as const).filter(([a]) => a.job === job);
    const vs = idx.map(([, i]) => byKey.get(keys[i] as string)).filter((v): v is Verdict => !!v);
    const ok = idx.map(([a]) => a).filter((a) => a.reply);
    rows[job] = {
      answers: idx.length,
      errors: idx.length - ok.length,
      judged: vs.length,
      falseClaims: vs.reduce((n, v) => n + v.falseClaims.length, 0),
      answersWithFalseClaim: vs.filter((v) => v.falseClaims.length).length,
      ...(job === 'hint' ? { givesAway: vs.filter((v) => v.givesAway).length } : {}),
      missesMainPoint: vs.filter((v) => v.missesMainPoint).length,
      poor: vs.filter((v) => v.sense === 'poor').length,
      good: vs.filter((v) => v.sense === 'good').length,
      misfitsLevel: vs.filter((v) => !v.fitsLevel).length,
      overWordBudget: ok.filter((a) => a.words > a.brief.maxWords).length,
      medianMs: Math.round(median(ok.map((a) => a.ms))),
      p90Ms: Math.round(p90(ok.map((a) => a.ms))),
      medianInputTokens: Math.round(median(ok.map((a) => (a.usage ? a.usage.inputTokens + a.usage.cacheReadTokens + a.usage.cacheWriteTokens : 0)))),
      medianOutputTokens: Math.round(median(ok.map((a) => a.usage?.outputTokens ?? 0))),
      costUsdPer100: Number((ok.reduce((n, a) => n + (a.usage?.costUsd ?? 0), 0) * (100 / Math.max(1, ok.length))).toFixed(3)),
    };
  }
  return rows;
}

/** The final judge's count for one round, per job: the false claims it upholds, giveaways, and how often this round coached better. */
export function finalTally(answers: ModelAnswer[], finals: FinalVerdict[], keys: string[]) {
  const rows: Record<string, Record<string, number>> = {};
  for (const job of ['hint', 'live'] as const) {
    const mine = new Set(answers.flatMap((a, i) => (a.job === job ? [keys[i] as string] : [])));
    const row = { pairs: 0, falseClaims: 0, answersWithFalseClaim: 0, givesAway: 0, better: 0, worse: 0, tie: 0 };
    for (const f of finals) {
      const key = f.keys.find((k) => mine.has(k));
      if (!key) continue;
      row.pairs++;
      const claims = f.falseClaims[key] ?? [];
      row.falseClaims += claims.length;
      if (claims.length) row.answersWithFalseClaim++;
      if (f.givesAway?.[key]) row.givesAway++;
      const side = f.keys[0] === key ? 'A' : 'B';
      if (f.better === 'tie') row.tie++;
      else if (f.better === side) row.better++;
      else row.worse++;
    }
    rows[job] = row;
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      select: { type: 'boolean' }, facts: { type: 'string' }, answer: { type: 'string' }, model: { type: 'string', default: 'haiku' }, only: { type: 'string' },
      packet: { type: 'string' }, round: { type: 'string' }, pairs: { type: 'boolean' }, summary: { type: 'boolean' }, engine: { type: 'string' }, out: { type: 'string' },
    },
  });
  const { quietSqliteWarning } = await import('../packages/backend/src/runtime.ts');
  quietSqliteWarning();
  const write = (data: unknown) => {
    const text = `${JSON.stringify(data, null, 1)}\n`;
    if (values.out) writeFileSync(values.out, text);
    else process.stdout.write(text);
  };
  const only = values.only?.split(',');
  if (values.select) {
    const positions = await select();
    writeFileSync(POSITIONS, `${JSON.stringify(positions, null, 1)}\n`);
    process.stderr.write(`${positions.filter((p) => p.job === 'hint').length} Hints, ${positions.filter((p) => p.job === 'live').length} Live Coaching\n`);
  } else if (values.facts) {
    const positions = (JSON.parse(readFileSync(POSITIONS, 'utf8')) as ModelEvalPosition[]).filter((p) => !only || only.includes(p.id));
    writeFileSync(values.facts, `${JSON.stringify(await facts(positions))}\n`);
  } else if (values.answer && !values.out) {
    process.stderr.write('--answer needs --out <answers.json>.\n');
    process.exit(2);
  } else if (values.answer && values.out) {
    const asks = (JSON.parse(readFileSync(values.answer, 'utf8')) as LevelAsk[]).filter((a) => !only || only.includes(a.id));
    writeFileSync(values.out, `${JSON.stringify(await answer(asks, values.model), null, 1)}\n`);
  } else if (values.packet && values.round && /haiku|sonnet|opus/i.test(values.round)) {
    process.stderr.write('Give the round a name that doesn\'t say the model, such as R1: its judge mustn\'t know.\n');
    process.exit(2);
  } else if (values.packet && values.round) {
    const view = await engineAt18();
    write(await packet(JSON.parse(readFileSync(values.packet, 'utf8')) as ModelAnswer[], values.round, (fen, uci) => view(fen, uci)));
  } else if (values.pairs && positionals.length === 2) {
    const [a, b] = positionals.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Awaited<ReturnType<typeof packet>>) as [Awaited<ReturnType<typeof packet>>, Awaited<ReturnType<typeof packet>>];
    write(pairs(a, b));
  } else if (values.summary && values.round && positionals.length >= 2) {
    const answers = JSON.parse(readFileSync(positionals[0] as string, 'utf8')) as ModelAnswer[];
    const verdicts = JSON.parse(readFileSync(positionals[1] as string, 'utf8')) as Verdict[];
    // The keys follow the answers' order, as --packet gave them.
    const keys = answers.map((_, i) => keyOf(values.round as string, i));
    const finals = positionals[2] ? (JSON.parse(readFileSync(positionals[2], 'utf8')) as FinalVerdict[]) : undefined;
    write({ rounds: summarize(answers, verdicts, keys), ...(finals ? { final: finalTally(answers, finals, keys) } : {}) });
  } else if (values.engine) {
    const view = await engineAt18();
    write(await view(values.engine, undefined, positionals));
  } else {
    process.stderr.write('Pass --select, --facts, --answer, --packet, --pairs, --summary or --engine (see the top of this file).\n');
    process.exit(2);
  }
  // The Engine keeps the event loop alive; the work is written, so stop here.
  process.exit(0);
}
