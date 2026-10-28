// Think deeper off versus on (ADR 0010): the real Coach answers a fixed set of positions both
// ways, from the same brief, and this script records every answer with its moves, the questions it
// asked the Engine, its tokens and its time. Judging the answers claim by claim against the
// Engine is done apart, from the file it writes, without knowing which mode wrote which answer.
//
//   node scripts/think-deeper-eval.ts --select              rewrite scripts/think-deeper-positions.json from the bundled puzzles and games
//   node scripts/think-deeper-eval.ts --out <file>          answer every position both ways on the latest Haiku
//   node scripts/think-deeper-eval.ts --out <file> --set held-out --model app
//
// --set picks the tuning set or the held-out one (default: tuning). --model is a model alias, or
// "app" for the model each job uses in the app's Balanced preset. It spends the owner's Claude
// limits: about two Coach calls per position.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { legalMoves, playUci, turnOf, type Side } from '../packages/shared/src/chess.ts';
import type { CoachAsk, CoachReply, CoachRequest } from '../packages/shared/src/coach/types.ts';
import { pickKeyMoments } from '../packages/shared/src/key-moments.ts';
import type { CoachJob } from '../packages/shared/src/protocol.ts';
import { parsePgnGames } from '../packages/shared/src/pgn.ts';

const POSITIONS = new URL('think-deeper-positions.json', import.meta.url);
const ENGINE = { depth: 14, multiPv: 5 };

interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  themes: string[];
  gameUrl: string;
}

/** One position of the set: a Why Question, or a key moment of a Review of a fixture game. */
export interface EvalPosition {
  id: string;
  set: 'tuning' | 'held-out';
  /** What the position tests, for reading the results. */
  kind: 'blunder' | 'deep-blunder' | 'missed' | 'why-not' | 'review';
  source: string;
  job: CoachJob;
  fen: string;
  recentMoves: string[];
  playerSide: Side;
  moveUci?: string;
  question?: string;
  /** For a Review moment: the game's moves from the start, and the key moment's ply. */
  game?: string[];
  ply?: number;
}

async function select(): Promise<EvalPosition[]> {
  const root = new URL('../', import.meta.url);
  const puzzles = [
    ...(JSON.parse(readFileSync(new URL('data/puzzles.json', root), 'utf8')) as { puzzles: Puzzle[] }).puzzles,
    ...(JSON.parse(readFileSync(new URL('data/theme-puzzles.json', root), 'utf8')) as { puzzles: Puzzle[] }).puzzles,
  ].sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set<string>();
  const pick = (test: (p: Puzzle) => boolean): Puzzle => {
    const p = puzzles.find((x) => !used.has(x.id) && test(x));
    if (!p) throw new Error('no puzzle left for a theme');
    used.add(p.id);
    return p;
  };
  const has = (...themes: string[]) => (p: Puzzle) => themes.some((t) => p.themes.includes(t));
  const out: EvalPosition[] = [];
  // A Why Question about the move that set the puzzle up: the Player's own blunder.
  const blunder = (p: Puzzle, set: EvalPosition['set'], kind: 'blunder' | 'deep-blunder'): EvalPosition => ({
    id: p.id, set, kind, source: p.gameUrl, job: 'why', fen: p.fen, recentMoves: [], playerSide: turnOf(p.fen), moveUci: p.moves[0] as string, question: 'Why is this a mistake?',
  });
  const after = (p: Puzzle) => playUci(p.fen, p.moves[0] as string)?.fenAfter as string;
  // A Why Question about the position after it, where the Player has the tactic to find.
  const missed = (p: Puzzle, set: EvalPosition['set']): EvalPosition => ({
    id: p.id, set, kind: 'missed', source: p.gameUrl, job: 'why', fen: after(p), recentMoves: [], playerSide: turnOf(after(p)), question: 'What should I play here, and why?',
  });
  for (const theme of ['fork', 'pin', 'discoveredAttack', 'skewer', 'backRankMate', 'hangingPiece']) out.push(blunder(pick(has(theme)), 'tuning', 'blunder'));
  for (const theme of ['mateIn3', 'veryLong', 'mateIn4', 'long']) out.push(blunder(pick(has(theme)), 'tuning', 'deep-blunder'));
  for (const theme of ['fork', 'mateIn2', 'discoveredAttack']) out.push(missed(pick(has(theme)), 'tuning'));
  const whyNot: Puzzle[] = [pick(has('deflection')), pick(has('attraction')), pick(has('sacrifice')), pick(has('capturingDefender'))];
  out.push(blunder(pick(has('capturingDefender')), 'held-out', 'blunder'));
  out.push(blunder(pick(has('veryLong')), 'held-out', 'deep-blunder'));
  out.push(missed(pick(has('sacrifice')), 'held-out'));

  // "Why not X?": X is the most natural-looking wrong move in the position after the setup move,
  // a capture or a check the Engine grades a Mistake or a Blunder.
  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine } = await import('../packages/backend/src/engine/node-engine.ts');
  const engine = new EngineService(() => createNodeEngine(), ENGINE);
  for (const [i, p] of whyNot.entries()) {
    const fen = after(p);
    let asked: string | undefined;
    for (const uci of legalMoves(fen)) {
      const san = playUci(fen, uci)?.san ?? '';
      if (!/[x+]/.test(san)) continue;
      const { move } = await engine.grade(fen, uci);
      if (move.grade === 'Mistake' || move.grade === 'Blunder') {
        asked = san;
        break;
      }
    }
    if (!asked) continue;
    out.push({
      id: p.id, set: i === 3 ? 'held-out' : 'tuning', kind: 'why-not', source: p.gameUrl, job: 'why', fen, recentMoves: [], playerSide: turnOf(fen), question: `Why not ${asked}?`,
    });
  }

  // Review moments: the first key moments of fixture games, graded at the desktop's depth.
  const games = parsePgnGames(readFileSync(new URL('packages/shared/test/fixtures/lichess-games.pgn', root), 'utf8'));
  const reviews: EvalPosition[] = [];
  for (const g of games.slice(0, 4)) {
    const graded = await engine.gradeGame(g.moves, g.startFen);
    for (const side of ['white', 'black'] as const) {
      const [m] = pickKeyMoments(graded, side);
      if (!m) continue;
      reviews.push({
        id: `${g.headers.Site?.split('/').pop() ?? 'game'}-${m.ply}`, set: 'tuning', kind: 'review', source: g.headers.Site ?? '', job: 'review-moment',
        fen: m.fenBefore, recentMoves: graded.slice(0, m.ply - 1).map((x) => x.san), playerSide: side, moveUci: m.uci, game: g.moves, ply: m.ply,
      });
    }
  }
  out.push(...reviews.slice(0, 4));
  const last = reviews[4];
  if (last) out.push({ ...last, set: 'held-out' });
  return out;
}

/** What the Coach was asked, and what came back, for one position in one mode. */
export interface EvalAnswer {
  id: string;
  mode: 'off' | 'on';
  model: string;
  reply?: CoachReply;
  error?: string;
  brief: unknown;
  questions: unknown[];
  usage?: unknown;
  ms: number;
}

async function answer(positions: EvalPosition[], model: string): Promise<EvalAnswer[]> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../packages/backend/src/db.ts');
  const { systemClock } = await import('../packages/backend/src/clock.ts');
  const { updateSettings, COACH_QUALITY_MODELS } = await import('../packages/backend/src/settings.ts');
  const { CoachService } = await import('../packages/backend/src/coach/service.ts');
  const { RealCoach } = await import('../packages/backend/src/coach/real.ts');
  const { EngineService } = await import('../packages/backend/src/engine/service.ts');
  const { createNodeEngine, desktopThreads } = await import('../packages/backend/src/engine/node-engine.ts');
  const { reviewScores } = await import('../packages/backend/src/reviews.ts');

  const db = openDb(mkdtempSync(join(tmpdir(), 'think-deeper-')));
  const engine = new EngineService(() => createNodeEngine(desktopThreads()), ENGINE);
  const coach = new CoachService(db, systemClock, new RealCoach());
  const models = model === 'app' ? COACH_QUALITY_MODELS.balanced : Object.fromEntries(Object.keys(COACH_QUALITY_MODELS.balanced).map((j) => [j, model]));
  updateSettings(db, { models });

  const out: EvalAnswer[] = [];
  for (const p of positions) {
    const ask = await askFor(p, engine, reviewScores);
    // Both modes get the same brief: the Engine's searches are cached, and the order alternates.
    const modes: ('off' | 'on')[] = out.length % 4 === 0 ? ['off', 'on'] : ['on', 'off'];
    for (const mode of modes) {
      updateSettings(db, { thinkDeeper: mode === 'on' });
      const started = Date.now();
      const row: EvalAnswer = { id: p.id, mode, model: models[p.job] ?? model, brief: coach.brief(ask), questions: [], ms: 0 };
      try {
        row.reply = await coach.ask(ask, () => {}, undefined, engine);
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
      row.ms = Date.now() - started;
      const call = db.prepare('SELECT id, raw_reply FROM coach_calls ORDER BY id DESC LIMIT 1').get() as { id: number; raw_reply: string | null } | undefined;
      row.usage = call?.raw_reply ? (JSON.parse(call.raw_reply) as { usage?: unknown }).usage : undefined;
      row.questions = (db.prepare('SELECT question, answer, refused FROM coach_questions WHERE call_id = ? ORDER BY id').all(call?.id ?? -1) as { question: string; answer: string | null; refused: string | null }[]).map(
        (q) => ({ question: JSON.parse(q.question) as unknown, answer: q.answer ? (JSON.parse(q.answer) as unknown) : undefined, refused: q.refused ?? undefined }),
      );
      out.push(row);
      process.stderr.write(`${p.id} ${mode}: ${row.error ?? `${row.reply?.engineQuestions ?? 0} questions, ${row.ms} ms`}\n`);
    }
  }
  return out;
}

/** The ask the app would build: a Why Question through the desktop's facts, a Review moment as a Review builds it. */
async function askFor(
  p: EvalPosition,
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

const { values } = parseArgs({ options: { select: { type: 'boolean' }, out: { type: 'string' }, set: { type: 'string', default: 'tuning' }, model: { type: 'string', default: 'haiku' }, only: { type: 'string' } } });
const { quietSqliteWarning } = await import('../packages/backend/src/runtime.ts');
quietSqliteWarning();
if (values.select) {
  const positions = await select();
  writeFileSync(POSITIONS, `${JSON.stringify(positions, null, 1)}\n`);
  process.stderr.write(`${positions.length} positions\n`);
} else if (values.out) {
  const all = JSON.parse(readFileSync(POSITIONS, 'utf8')) as EvalPosition[];
  const only = values.only?.split(',');
  const positions = all.filter((p) => p.set === values.set && (!only || only.includes(p.id)));
  writeFileSync(values.out, `${JSON.stringify(await answer(positions, values.model), null, 1)}\n`);
} else {
  process.stderr.write('Pass --select or --out <file>.\n');
  process.exit(2);
}
// The Engine keeps the event loop alive; the work is written, so stop here.
process.exit(0);
