// The tempting moves of a Coach call (ADR 0011): Maia-3 (or Opus until its model is downloaded)
// guesses the moves many players at the Player's level would reach for, and the desktop's Engine
// grades each one as it grades a move the Player asks about, before the brief is built. The guess
// starts alongside the Engine's other searches, so an Opus guess adds only its own wait.
import { INITIAL_FEN, playSan, positionKey } from '@chess-coach/shared/chess';
import type { Candidate } from '@chess-coach/shared/analysis';
import type { CoachAsk } from '@chess-coach/shared/coach/types';
import type { CoachJob } from '@chess-coach/shared/protocol';
import type { EngineService } from '../engine/service.ts';
import type { TemptingMovesResult, TemptingMovesService } from './service.ts';

/**
 * The jobs whose brief gets tempting moves. Why Questions and Review moments, where the Coach has
 * room to say why the obvious move fails; Hints, only from the local model, to point at a trap
 * without naming it; never Live Coaching, which must stay short, nor Lesson turns, which have the
 * players' own popularity list.
 */
export const TEMPTING_JOBS: readonly CoachJob[] = ['why', 'review-moment', 'hint'];
/** How many tempting moves a brief gets. */
export const TEMPTING_COUNT = 3;

export interface Guess {
  service: TemptingMovesService;
  /** The Player's rating on the Lichess blitz scale (see rating.ts). */
  rating: number;
  /** The game up to the position: its first position and its moves in UCI. */
  history: { startFen: string; moves: readonly string[] };
  signal?: AbortSignal;
}

/**
 * Starts guessing the tempting moves for a Coach job, or undefined when the job gets none. A Hint
 * gets them only from this desktop's model: an Opus guess would add seconds to an answer that must
 * stay quick.
 */
export function guessTempting(job: CoachJob, guess: Guess): Promise<TemptingMovesResult> | undefined {
  if (!TEMPTING_JOBS.includes(job)) return undefined;
  if (job === 'hint' && !guess.service.isLocal()) return undefined;
  const { startFen, moves } = guess.history;
  const out = guess.service.suggest({
    startFen,
    moves,
    rating: guess.rating,
    // The opponent's rating isn't known: Players mostly meet opponents near their own.
    opponentRating: guess.rating,
    count: TEMPTING_COUNT,
    ...(guess.signal ? { signal: guess.signal } : {}),
  });
  // A request the Engine then refuses never reads the guess: don't let it fail unseen.
  out.catch(() => undefined);
  return out;
}

/**
 * The game up to `fen` from a client's SAN moves, when they are the game from its usual start and
 * lead to `fen`; otherwise `fen` alone, as for a position set up by hand. Maia-3 reads the last 8
 * positions, and a history that doesn't end at `fen` would describe a different game.
 */
export function historyFromSans(fen: string, sans: readonly unknown[]): Guess['history'] {
  let current = INITIAL_FEN;
  const moves: string[] = [];
  for (const san of sans) {
    const played = typeof san === 'string' ? playSan(current, san) : undefined;
    if (!played) return { startFen: fen, moves: [] };
    moves.push(played.uci);
    current = played.fenAfter;
  }
  return positionKey(current) === positionKey(fen) ? { startFen: INITIAL_FEN, moves } : { startFen: fen, moves: [] };
}

/**
 * The ask with its tempting moves graded by the Engine: an Engine candidate as it is, any other as
 * `gradeAsked` grades a move the Player asks about, cached like the brief's other searches. Records
 * where they came from for the call log.
 */
export async function withTempting(ask: CoachAsk, guess: Promise<TemptingMovesResult> | undefined, engine: EngineService): Promise<CoachAsk> {
  if (!guess) return ask;
  const result = await guess;
  const tempting: Candidate[] = await Promise.all(
    result.moves.map(async (uci) => ask.candidates.find((c) => c.uci === uci) ?? (await engine.gradeAsked(ask.fen, uci)).move),
  );
  return {
    ...ask,
    ...(tempting.length ? { tempting } : {}),
    temptingFrom: { source: result.source, moves: result.moves, ms: result.ms, ...(result.usage ? { usage: result.usage } : {}) },
  };
}
