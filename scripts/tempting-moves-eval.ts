// Tempting moves off versus on (ADR 0011): the real Coach answers a fixed set of positions both
// ways, from the same Engine facts, and this script records every answer. Half the positions are
// real players' quick mistakes (docs/research/human-move-prediction.md), asked as "What should I
// play here?" with the game's moves and the player's rating: does the Coach warn of the move the
// player actually reached for? The rest are the Think deeper set's (scripts/think-deeper-positions.json).
// Judging the answers claim by claim against the Engine is done apart, from the file this writes,
// without knowing which mode wrote which answer; `--engine` gives the judges the Engine at depth 18.
//
//   node scripts/tempting-moves-eval.ts --select <research samples.json>   write scripts/tempting-moves-positions.json
//   node scripts/tempting-moves-eval.ts --out <file> [--model app]       answer every position both ways
//   node scripts/tempting-moves-eval.ts --engine "<fen>" [SAN ...]        the Engine at depth 18: its best moves, and each SAN graded
//
// The tempting moves come from Maia-3: MAIA_MODEL, or the app's downloaded model file. It spends the
// owner's Claude limits: two Coach calls per position.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { INITIAL_FEN, playSan, playUci } from '../packages/shared/src/chess.ts';
import type { CoachAsk, CoachReply, CoachRequest } from '../packages/shared/src/coach/types.ts';
import type { EvalPosition } from './think-deeper-eval.ts';

const POSITIONS = new URL('tempting-moves-positions.json', import.meta.url);
const ENGINE = { depth: 14, multiPv: 5 };

/** One position: a Think deeper one, or a quick mistake with its game, rating and the move the player made. */
export interface TemptingPosition extends EvalPosition {
  /** For a quick mistake: the game's moves (UCI) up to the position, the mover's Lichess rating, and the move made. */
  history?: string[];
  rating?: number;
  played?: { uci: string; san: string; grade: string; seconds: number };
}

interface ResearchSample {
  id: string;
  band: string;
  phase: string;
  fen: string;
  moves: string[];
  elo: number;
  site: string;
  played: { uci: string; san: string };
  seconds: number;
  group: string;
  grade: string;
}

/** Three quick Mistakes or Blunders past the opening from each rating band, and six Think deeper positions. */
function select(samplesPath: string): TemptingPosition[] {
  const samples = JSON.parse(readFileSync(samplesPath, 'utf8')) as ResearchSample[];
  const out: TemptingPosition[] = [];
  for (const band of ['u1200', '1200-1600', '1600-2000', '2000+']) {
    const picked = samples.filter((s) => s.band === band && s.group === 'mistake' && (s.grade === 'Mistake' || s.grade === 'Blunder') && s.phase !== 'opening').slice(0, 3);
    for (const s of picked) {
      let fen = INITIAL_FEN;
      const sans: string[] = [];
      for (const uci of s.moves) {
        const m = playUci(fen, uci)!;
        sans.push(m.san);
        fen = m.fenAfter;
      }
      out.push({
        id: s.id, set: 'tuning', kind: 'missed', source: s.site, job: 'why', fen: s.fen, recentMoves: sans, playerSide: s.fen.split(' ')[1] === 'w' ? 'white' : 'black',
        question: 'What should I play here, and why?', history: s.moves, rating: s.elo, played: { ...s.played, grade: s.grade, seconds: s.seconds },
      });
    }
  }
  const deeper = (JSON.parse(readFileSync(new URL('think-deeper-positions.json', import.meta.url), 'utf8')) as EvalPosition[]).filter((p) => p.set === 'tuning');
  for (const kind of ['blunder', 'blunder', 'missed', 'why-not', 'review', 'review'] as const) {
    const p = deeper.find((x) => x.kind === kind && !out.some((o) => o.id === x.id));
    if (p) out.push(p);
  }
  return out;
}

/** What the Coach said about one position in one mode. */
export interface TemptingAnswer {
  id: string;
  mode: 'off' | 'on';
  model: string;
  reply?: CoachReply;
  error?: string;
  brief: unknown;
  /** The tempting moves the brief had, in SAN with their Move Grades. */
  tempting: string[];
  /** For a quick mistake: whether the answer names the move the player actually made. */
  namesPlayed?: boolean;
  ms: number;
}

async function answer(positions: TemptingPosition[], model: string): Promise<TemptingAnswer[]> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { openDb } = await import('../packages/backend/src/db.ts');
  const { systemClock } = await import('../packages/backend/src/clock.ts');
  const { updateSettings, COACH_QUALITY_MODELS } = await import('../packages/backend/src/settings.ts');
  const { CoachService } = await import('../packages/backend/src/coach/service.ts');
  const { RealCoach } = await import('../packages/backend/src/coach/real.ts');
  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine, desktopThreads } = await import('../packages/backend/src/engine/node-engine.ts');
  const { reviewScores } = await import('../packages/backend/src/reviews.ts');
  const { defaultDataDir } = await import('../packages/backend/src/paths.ts');
  const { MAIA3_5M } = await import('../packages/backend/src/tempting-moves/download.ts');
  const { MaiaTemptingMoves } = await import('../packages/backend/src/tempting-moves/maia.ts');
  const { TemptingMovesService } = await import('../packages/backend/src/tempting-moves/service.ts');
  const { guessTempting, withTempting } = await import('../packages/backend/src/tempting-moves/ask.ts');

  const modelPath = process.env.MAIA_MODEL ?? join(defaultDataDir(), 'models', `${MAIA3_5M.name}-${MAIA3_5M.sha256.slice(0, 8)}.onnx`);
  if (!existsSync(modelPath)) throw new Error(`No Maia-3 model at ${modelPath}: set MAIA_MODEL.`);
  const maia = await MaiaTemptingMoves.load(new Uint8Array(readFileSync(modelPath)), desktopThreads());
  const tempting = new TemptingMovesService({ fallback: { ...maia, name: 'maia', suggest: (req) => maia.suggest(req) } });

  const db = openDb(mkdtempSync(join(tmpdir(), 'tempting-moves-')));
  const engine = new EngineService(() => createNodeEngine(desktopThreads()), ENGINE);
  const coach = new CoachService(db, systemClock, new RealCoach());
  const models = model === 'app' ? COACH_QUALITY_MODELS.balanced : Object.fromEntries(Object.keys(COACH_QUALITY_MODELS.balanced).map((j) => [j, model]));
  updateSettings(db, { models, thinkDeeper: false });

  const out: TemptingAnswer[] = [];
  for (const p of positions) {
    // The Player's rating, as the Player Profile would hold it: in the brief, and for Maia-3.
    db.prepare("UPDATE profile SET rating = ?, rating_site = 'lichess', rating_username = 'eval' WHERE id = 1").run(p.rating ?? null);
    const facts = await factsFor(p, engine, reviewScores);
    const history = p.history ? { startFen: INITIAL_FEN, moves: p.history } : { startFen: p.fen, moves: [] };
    const on = await withTempting(facts, guessTempting(p.job, { service: tempting, rating: p.rating ?? 1500, history }), engine);
    // Both modes get the same facts; the order alternates.
    const modes = out.length % 4 === 0 ? (['off', 'on'] as const) : (['on', 'off'] as const);
    for (const mode of modes) {
      const ask: CoachAsk = mode === 'on' ? on : facts;
      const brief = coach.brief(ask) as { fen: string; candidates: { san: string; grade: string; tempting?: true }[]; tempting?: { san: string; grade: string }[]; move?: { san: string; tempting?: true } };
      const started = Date.now();
      const row: TemptingAnswer = {
        id: p.id, mode, model: models[p.job] ?? model, brief,
        tempting: [...brief.candidates.filter((c) => c.tempting), ...(brief.tempting ?? [])].map((t) => `${t.san} (${t.grade})`),
        ms: 0,
      };
      try {
        row.reply = await coach.ask(ask, () => {});
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
      row.ms = Date.now() - started;
      if (p.played && row.reply) row.namesPlayed = new RegExp(`(^|[^\\w])${p.played.san.replace(/[+#]$/, '').replace(/[+]/g, '\\+')}([+#]|[^\\w]|$)`).test(row.reply.text);
      out.push(row);
      process.stderr.write(`${p.id} ${mode}: ${row.error ?? `${row.ms} ms${row.namesPlayed === undefined ? '' : `, names ${p.played?.san}: ${row.namesPlayed}`}`}\n`);
    }
  }
  return out;
}

/** The facts the app would build: a Why Question through the desktop's Engine, a Review moment as a Review builds it. */
async function factsFor(
  p: TemptingPosition,
  engine: import('../packages/backend/src/engine/service.ts').EngineService,
  reviewScores: (graded: import('../packages/shared/src/analysis.ts').GradedMove[], ply: number) => Partial<CoachAsk>,
): Promise<CoachAsk> {
  if (p.job !== 'review-moment') {
    const req: CoachRequest = { job: p.job, fen: p.fen, recentMoves: p.recentMoves, playerSide: p.playerSide, ...(p.moveUci ? { moveUci: p.moveUci } : {}), ...(p.question ? { question: p.question } : {}) };
    return engine.factsFor(req);
  }
  const graded = await engine.gradeGame(p.game ?? []);
  const m = graded[(p.ply ?? 1) - 1];
  if (!m) throw new Error(`${p.id}: no such ply`);
  const threat = await engine.threat(m.fenBefore);
  return {
    job: 'review-moment', fen: m.fenBefore, recentMoves: p.recentMoves, playerSide: p.playerSide,
    move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore }, candidates: m.candidates,
    ...reviewScores(graded, m.ply), replies: graded[m.ply]?.candidates ?? [], ...(threat ? { threat } : {}),
  };
}

/** For the judges: the Engine at depth 18, its best five moves in `fen`, and each SAN graded against them. */
async function engineAt18(fen: string, sans: string[]): Promise<unknown> {
  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine, desktopThreads } = await import('../packages/backend/src/engine/node-engine.ts');
  const { formatScore } = await import('../packages/shared/src/grader.ts');
  const { sanLine } = await import('../packages/shared/src/chess.ts');
  const engine = new EngineService(() => createNodeEngine(desktopThreads()), { depth: 18, multiPv: 5 });
  const best = await engine.analyse(fen);
  const line = (uci: string, pv: string[]) => sanLine(fen, [uci, ...pv].slice(0, 8)).join(' ');
  const graded = [];
  for (const san of sans) {
    const uci = playSan(fen, san)?.uci;
    if (!uci) {
      graded.push({ san, error: 'not a legal move here' });
      continue;
    }
    const { move, replies } = await engine.grade(fen, uci);
    graded.push({ san: move.san, grade: move.grade, evaluation: formatScore(move.playedScore), line: line(uci, replies[0]?.pv ?? []) });
  }
  return { fen, best: best.lines.map((l) => ({ san: playUci(fen, l.pv[0]!)?.san, evaluation: formatScore(l.score), line: line(l.pv[0]!, l.pv.slice(1)) })), graded };
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { select: { type: 'string' }, out: { type: 'string' }, model: { type: 'string', default: 'app' }, engine: { type: 'string' }, only: { type: 'string' } } });
const { quietSqliteWarning } = await import('../packages/backend/src/runtime.ts');
quietSqliteWarning();
if (values.select) {
  const positions = select(values.select);
  writeFileSync(POSITIONS, `${JSON.stringify(positions, null, 1)}\n`);
  process.stderr.write(`${positions.length} positions\n`);
} else if (values.out) {
  const only = values.only?.split(',');
  const positions = (JSON.parse(readFileSync(POSITIONS, 'utf8')) as TemptingPosition[]).filter((p) => !only || only.includes(p.id));
  writeFileSync(values.out, `${JSON.stringify(await answer(positions, values.model), null, 1)}\n`);
} else if (values.engine) {
  process.stdout.write(`${JSON.stringify(await engineAt18(values.engine, positionals), null, 1)}\n`);
} else {
  process.stderr.write('Pass --select <samples.json>, --out <file> or --engine "<fen>" [SAN ...].\n');
  process.exit(2);
}
// The Engine keeps the event loop alive; the work is written, so stop here.
process.exit(0);
