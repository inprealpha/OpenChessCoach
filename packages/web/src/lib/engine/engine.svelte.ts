// One Engine for the whole app, with a cache so each position is analysed once.
import { gradeFromAnalyses, type GameSoFar, type GradedMove } from '@chess-coach/shared/analysis';
import { outcomeOf } from '@chess-coach/shared/chess';
import type { Analysis, PlayOptions } from '@chess-coach/shared/engine';
import { findThreat, type Threat } from '@chess-coach/shared/threat';
import { api } from '../api.svelte.ts';
import { BrowserEngine } from './browser-engine.ts';
import { desktopFirst } from './desktop-first.ts';

let starting: Promise<BrowserEngine> | undefined;
// A plain cache, not state: nothing renders from it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const cache = new Map<string, Promise<Analysis>>();

export const engineStatus = $state<{ error: string | null }>({ error: null });

async function startEngine(threads: number): Promise<BrowserEngine> {
  const e = new BrowserEngine({ threads, deterministic: api.engine.singleThread, startTimeoutMs: 20_000 });
  try {
    await e.whenReady();
    return e;
  } catch (err) {
    e.dispose();
    throw err;
  }
}

/**
 * The app's one Engine. The multi-threaded build is tried where the browser allows it; if it
 * can't start, the single-threaded build is tried once, and if that fails too the Player is told.
 */
export function engine(): Promise<BrowserEngine> {
  starting ??= (async () => {
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    const threads = !api.engine.singleThread && isolated ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    if (threads > 1) {
      try {
        return await startEngine(threads);
      } catch {
        // fall back to one thread below
      }
    }
    return startEngine(1);
  })().catch((err: unknown) => {
    engineStatus.error = 'The Engine couldn’t start in this browser, so moves can’t be graded or played. Try another browser, such as Chrome, Safari or Firefox.';
    throw err;
  });
  return starting;
}

/** The Engine's move in a position, for Engine Games. */
export async function bestMove(fen: string, options: PlayOptions): Promise<string> {
  return (await engine()).bestMove(fen, options);
}

/** Analyses a position at the configured depth, with the configured lines unless told fewer. Progress updates stream to `onProgress`. */
export function analyse(fen: string, onProgress?: (a: Analysis) => void, multiPv = api.engine.multiPv): Promise<Analysis> {
  const key = `${fen}|${api.engine.depth}|${multiPv}`;
  let hit = cache.get(key);
  if (!hit) {
    if (outcomeOf(fen)) hit = Promise.resolve({ fen, depth: 0, lines: [] });
    else hit = engine().then((e) => e.analyse(fen, { multiPv, depth: api.engine.depth }, onProgress));
    cache.set(key, hit);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}

/**
 * The opponent's threat in a position, for the Board and Engine Games: from the same cached
 * analyses as the board's lines, so a position already analysed costs one more search, of one
 * line, as on the desktop.
 */
export function threat(fen: string): Promise<Threat | undefined> {
  return findThreat((f, multiPv) => analyse(f, undefined, multiPv), fen);
}

/** The opponent's threat for a Review: from the desktop's Engine, which graded the game, unless it can't be reached (ADR 0007). */
export function threatOnDesktop(fen: string): Promise<Threat | undefined> {
  return desktopFirst(
    api.state === 'online',
    async () => (await api.request('engine.threat', { fen })).threat ?? undefined,
    () => threat(fen),
  );
}

/**
 * Grades a move the Engine way: the analyses before and after it, nothing else (ADR 0002). With
 * the game so far, a move that repeats a position a third time is graded as the draw it is.
 */
export async function gradeMove(ply: number, fenBefore: string, uci: string, fenAfter: string, game?: GameSoFar): Promise<GradedMove> {
  const [before, after] = await Promise.all([analyse(fenBefore), analyse(fenAfter)]);
  return gradeFromAnalyses(ply, uci, before, after, game);
}

/**
 * Grades a move for Coach work, such as a Lesson turn: on the desktop's Engine, so the Move Grade
 * matches the facts the Coach is given (ADR 0007), and in the browser when the desktop can't be reached.
 */
export function gradeForCoach(ply: number, fenBefore: string, uci: string, fenAfter: string): Promise<GradedMove> {
  return desktopFirst(
    api.state === 'online',
    async () => (await api.request('engine.grade', { fen: fenBefore, uci, ply })).move,
    () => gradeMove(ply, fenBefore, uci, fenAfter),
  );
}

/** The Engine's lines for Coach work, such as a Hint: from the desktop unless it can't be reached (ADR 0007). */
export function analyseForCoach(fen: string): Promise<Analysis> {
  return desktopFirst(api.state === 'online', () => api.request('engine.analyse', { fen }), () => analyse(fen));
}
