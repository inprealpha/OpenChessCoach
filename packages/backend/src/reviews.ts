// Reviews: the desktop Engine's grades for every move (ADR 0007), the 3 to 5 key moments, and
// the Coach's explanation of each. A saved Review is reread with no Coach call.
import type { GradedMove } from '@chess-coach/shared/analysis';
import { formatScore, type MoveGrade } from '@chess-coach/shared/grader';
import { pickKeyMoments } from '@chess-coach/shared/key-moments';
import type { CoachAsk } from '@chess-coach/shared/coach/types';
import { scoreAfterPly } from '@chess-coach/shared/position-score';
import type { KeyMoment, Review } from '@chess-coach/shared/protocol';
import { type Clock, iso } from './clock.ts';
import { all, one, transaction, type Db } from './db.ts';
import { getGame } from './games.ts';
import { addGradeCounts, removeGradeCounts } from './profile.ts';
import type { CoachService } from './coach/service.ts';
import type { EngineService } from './engine/service.ts';

export function getReview(db: Db, gameId: number): Review | null {
  const row = one<{ created_at: string; moments: string }>(db, 'SELECT * FROM reviews WHERE game_id = ?', gameId);
  if (!row) return null;
  const moves = all<{ data: string }>(db, 'SELECT data FROM graded_moves WHERE game_id = ? ORDER BY ply', gameId).map(
    (r) => JSON.parse(r.data) as GradedMove,
  );
  return { gameId, createdAt: row.created_at, moments: JSON.parse(row.moments) as KeyMoment[], moves };
}

/** The scores a Review shows either side of the move at `ply`, so the Coach quotes them. */
export function reviewScores(graded: readonly GradedMove[], ply: number): Pick<CoachAsk, 'positionBefore' | 'positionAfter'> {
  const before = scoreAfterPly(graded, ply - 1);
  const after = scoreAfterPly(graded, ply);
  return { ...(before ? { positionBefore: before } : {}), ...(after ? { positionAfter: after } : {}) };
}

/**
 * A Why Question asked from a Review: the positions either side of the move scored from the
 * desktop's own graded moves, as the Review's bar and key moments score them (ADR 0007).
 * Any other ask, or a move this game's Review didn't grade, comes back unchanged.
 */
export function withReviewScores(db: Db, gameId: unknown, ask: CoachAsk): CoachAsk {
  if (typeof gameId !== 'number' || !ask.move) return ask;
  const graded = getReview(db, gameId)?.moves ?? [];
  const index = graded.findIndex((m) => m.fenBefore === ask.fen && m.uci === ask.move?.uci);
  return index < 0 ? ask : { ...ask, ...reviewScores(graded, index + 1) };
}

/**
 * How long a Review's key moments may spend asking the Engine, with Think deeper on (ADR 0010). Once
 * they have taken this long, the remaining moments answer from the brief alone, so a Review never
 * waits on the Engine tool for every moment of a long game.
 */
export const REVIEW_ENGINE_BUDGET_MS = 180_000;

export interface ReviewDeps {
  db: Db;
  clock: Clock;
  coach: CoachService;
  engine: EngineService;
}

/** Hears a Review being made: its progress, and the Coach's explanations as they are written. */
interface Listener {
  delta: (text: string, part: number) => void;
  progress: (done: number, total: number) => void;
}

/** A Review being made, the requests waiting for it, and how far it has got, for a request that joins late. */
interface Making {
  made: Promise<Review>;
  listeners: Set<Listener>;
  progress: [done: number, total: number] | undefined;
  texts: string[];
}

/** Reviews being made right now, per database and game, so a second request joins the first. */
const inFlight = new WeakMap<Db, Map<number, Making>>();

/** Whether a Review of this game is being made right now. */
export function reviewInProgress(db: Db, gameId: number): boolean {
  return inFlight.get(db)?.has(gameId) ?? false;
}

/**
 * Drops a game's Review and takes back the Move Grades it counted into the Player Profile, for a
 * game whose side changed or that is being deleted. Run it inside that change's transaction.
 */
export function dropReview(db: Db, gameId: number): void {
  if (!one(db, 'SELECT 1 FROM reviews WHERE game_id = ?', gameId)) return;
  const game = getGame(db, gameId);
  // The sample game's Review never counted into the Player Profile, so there is nothing to take back.
  if (game.source !== 'sample') {
    const grades = all<{ grade: MoveGrade }>(db, 'SELECT grade FROM graded_moves WHERE game_id = ? AND side = ?', gameId, game.playerSide);
    removeGradeCounts(db, game.opening, grades.map((g) => g.grade));
  }
  db.prepare('DELETE FROM graded_moves WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM reviews WHERE game_id = ?').run(gameId);
}

/**
 * Grades the whole game on the desktop's Engine (ADR 0007), then asks the Coach about each key
 * moment. These grades are the record that counts, even where an Engine Game showed others.
 * A request for a Review that is already being made joins that one rather than making a second,
 * so a double click saves one Review and counts its Move Grades once. A request that joins late
 * first hears how far the Review has got, then the rest as it comes. Only `signal` stops a
 * Review: a request that goes away with its connection leaves it to finish and be saved.
 */
export async function startReview(
  deps: ReviewDeps,
  gameId: number,
  delta: (text: string, part: number) => void,
  progress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Review> {
  const existing = getReview(deps.db, gameId);
  if (existing) return existing;
  let running = inFlight.get(deps.db);
  if (!running) inFlight.set(deps.db, (running = new Map()));
  let making = running.get(gameId);
  if (making) {
    // Joining late: first where the Review has got to.
    if (making.progress) progress(...making.progress);
    making.texts.forEach((text, part) => delta(text, part));
  } else {
    const m: Making = {
      listeners: new Set(),
      progress: undefined,
      texts: [],
      made: makeReview(
        deps,
        gameId,
        (text, part) => {
          m.texts[part] = (m.texts[part] ?? '') + text;
          for (const l of m.listeners) l.delta(text, part);
        },
        (done, total) => {
          m.progress = [done, total];
          for (const l of m.listeners) l.progress(done, total);
        },
        signal,
      ).finally(() => running.delete(gameId)),
    };
    running.set(gameId, (making = m));
  }
  const listener: Listener = { delta, progress };
  making.listeners.add(listener);
  try {
    return await making.made;
  } finally {
    making.listeners.delete(listener);
  }
}

async function makeReview(
  { db, clock, coach, engine }: ReviewDeps,
  gameId: number,
  delta: (text: string, part: number) => void,
  progress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Review> {
  const game = getGame(db, gameId);
  // Check the Coach can answer before spending the Engine's time on the whole game.
  await coach.assertAvailable();
  const graded = await engine.gradeGame(game.moves, game.startFen, progress, signal);
  const moments = pickKeyMoments(graded, game.playerSide);
  // The sample game isn't the Player's: its Review never feeds the Player Profile.
  const counts = game.source !== 'sample';
  const out: KeyMoment[] = [];
  const started = clock.now().getTime();
  for (const [index, m] of moments.entries()) {
    // What the opponent threatened before the move: the brief keeps it only when the Engine's best
    // reply to the move is that threat, so the Coach can say the move left it on.
    const threat = await engine.threat(m.fenBefore);
    const reply = await coach.ask(
      {
        job: 'review-moment',
        fen: m.fenBefore,
        recentMoves: graded.slice(0, m.ply - 1).map((g) => g.san),
        playerSide: game.playerSide,
        move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
        candidates: m.candidates,
        // The Coach quotes the Winning Chances the key moment shows, scored as the screen scores them.
        ...reviewScores(graded, m.ply),
        replies: graded[m.ply]?.candidates ?? [],
        ...(threat ? { threat } : {}),
        opening: game.opening,
        allowNote: counts && index === moments.length - 1,
      },
      (text) => delta(text, index),
      signal,
      clock.now().getTime() - started < REVIEW_ENGINE_BUDGET_MS ? engine : undefined,
    );
    out.push({
      ply: m.ply,
      san: m.san,
      uci: m.uci,
      grade: m.grade,
      fenBefore: m.fenBefore,
      betterOptions: m.candidates
        .filter((c) => c.uci !== m.uci)
        .slice(0, 3)
        .map((c) => ({ uci: c.uci, san: c.san, score: formatScore(c.score) })),
      explanation: reply.text,
      arrows: reply.arrows,
    });
  }
  transaction(db, () => {
    db.prepare('DELETE FROM graded_moves WHERE game_id = ?').run(gameId);
    const put = db.prepare(
      'INSERT INTO graded_moves (game_id, ply, side, uci, san, grade, win_loss, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const m of graded) put.run(gameId, m.ply, m.side, m.uci, m.san, m.grade, m.winLoss, JSON.stringify(m));
    db.prepare('INSERT INTO reviews (game_id, created_at, moments) VALUES (?, ?, ?)').run(gameId, iso(clock), JSON.stringify(out));
  });
  if (counts) {
    addGradeCounts(
      db,
      game.opening,
      graded.filter((m) => m.side === game.playerSide).map((m) => m.grade),
    );
  }
  return getReview(db, gameId) as Review;
}
