// The desktop's Engine (ADR 0007): it grades games for Reviews, grades Lesson turns, and computes
// every Engine fact in a Coach brief, so the Coach move guard checks the Coach against facts the
// backend produced, never facts a client sent. Each position is analysed once.
import { candidatesFrom, gradeFromAnalyses, gradeGame, type Candidate, type GradedMove } from '@chess-coach/shared/analysis';
import { INITIAL_FEN, isValidFen, outcomeOf, playLine } from '@chess-coach/shared/chess';
import type { CoachAsk, CoachRequest } from '@chess-coach/shared/coach/types';
import type { Analysis, Engine } from '@chess-coach/shared/engine';
import { findThreat, type Threat } from '@chess-coach/shared/threat';
import { AppError } from '../errors.ts';

export interface EngineSettings {
  depth: number;
  multiPv: number;
}

const CACHE_SIZE = 2000;

/** A client's Lesson context, checked field by field so a malformed one is refused rather than breaking the brief. */
function lessonOf(value: unknown): NonNullable<CoachAsk['lesson']> {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const isEntry = (p: unknown) => isRecord(p) && typeof p.san === 'string' && typeof p.percent === 'number' && Number.isFinite(p.percent);
  if (
    !isRecord(value) ||
    typeof value.lessonId !== 'string' ||
    typeof value.opening !== 'string' ||
    typeof value.notes !== 'string' ||
    typeof value.finalTurn !== 'boolean' ||
    !Array.isArray(value.popularity) ||
    !value.popularity.every(isEntry)
  ) {
    throw new AppError('bad-request', 'The Lesson context is not valid.');
  }
  const popularity = (value.popularity as { san: string; percent: number }[]).map(({ san, percent }) => ({ san, percent }));
  return { lessonId: value.lessonId, opening: value.opening, notes: value.notes, popularity, finalTurn: value.finalTurn };
}

export class EngineService {
  private engine: Promise<Engine> | undefined;
  private readonly cache = new Map<string, Promise<Analysis>>();
  private readonly start: () => Promise<Engine>;
  readonly settings: EngineSettings;

  constructor(start: () => Promise<Engine>, settings: EngineSettings) {
    this.start = start;
    this.settings = settings;
  }

  private async get(): Promise<Engine> {
    this.engine ??= this.start().catch((err: unknown) => {
      this.engine = undefined;
      throw new AppError('engine-unavailable', `The Engine couldn’t start on the desktop: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.engine;
  }

  /** The Engine's top lines in a position, at the configured depth. */
  async analyse(fen: string): Promise<Analysis> {
    if (!isValidFen(fen)) throw new AppError('bad-request', 'The position is not valid.');
    if (outcomeOf(fen)) return { fen, depth: 0, lines: [] };
    const hit = this.cache.get(fen);
    if (hit) return hit;
    const analysis = this.get().then((e) => e.analyse(fen, { multiPv: this.settings.multiPv, depth: this.settings.depth }));
    this.cache.set(fen, analysis);
    analysis.catch(() => this.cache.delete(fen));
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return analysis;
  }

  /**
   * The opponent's threat in a position, from the cached analyses at the configured depth: a
   * position the desktop already analysed, as every position of a graded game is, costs only the
   * search after the null move.
   */
  async threat(fen: string): Promise<Threat | undefined> {
    if (!isValidFen(fen)) throw new AppError('bad-request', 'The position is not valid.');
    return findThreat((f) => this.analyse(f), fen);
  }

  /** Grades one move and lists the Engine's replies to it. */
  async grade(fen: string, uci: string, ply = 1): Promise<{ move: GradedMove; replies: Candidate[] }> {
    if (!isValidFen(fen)) throw new AppError('bad-request', 'The position is not valid.');
    const played = playLine(fen, [uci])[0];
    if (!played) throw new AppError('bad-request', `${uci} is not a legal move in this position.`);
    const [before, after] = await Promise.all([this.analyse(fen), this.analyse(played.fenAfter)]);
    if (!before.lines.length) throw new AppError('bad-request', 'The game is already over in this position.');
    return { move: gradeFromAnalyses(ply, played.uci, before, after), replies: candidatesFrom(after) };
  }

  /** Grades every move of a game, reporting each position as it is analysed. */
  async gradeGame(moves: readonly string[], startFen = INITIAL_FEN, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<GradedMove[]> {
    // The shared grader drives any Engine; this one answers from the cache.
    const cached: Engine = {
      analyse: (fen) => {
        if (signal?.aborted) return Promise.reject(new AppError('cancelled', 'The Review was cancelled.'));
        return this.analyse(fen);
      },
      bestMove: () => Promise.reject(new Error('not used')),
      threat: (fen) => this.threat(fen),
      stop: () => undefined,
      dispose: () => undefined,
    };
    return gradeGame(cached, moves, this.settings, startFen, onProgress);
  }

  /**
   * Turns a client's Coach request into a full ask with the Engine's facts. Anything a client
   * sends besides the position and the moves played is ignored (ADR 0007).
   */
  async factsFor(req: CoachRequest): Promise<CoachAsk> {
    const ask: CoachAsk = {
      job: req.job,
      fen: req.fen,
      recentMoves: Array.isArray(req.recentMoves) ? req.recentMoves.filter((m) => typeof m === 'string') : [],
      candidates: [],
      ...(req.threadId ? { threadId: req.threadId } : {}),
      ...(req.playerSide === 'white' || req.playerSide === 'black' ? { playerSide: req.playerSide } : {}),
      ...(typeof req.question === 'string' ? { question: req.question } : {}),
      ...(req.lesson !== undefined ? { lesson: lessonOf(req.lesson) } : {}),
      ...(typeof req.opening === 'string' ? { opening: req.opening } : {}),
    };
    if (req.moveUci) {
      const { move, replies } = await this.grade(req.fen, req.moveUci);
      return {
        ...ask,
        move: { uci: move.uci, san: move.san, grade: move.grade, playedScore: move.playedScore },
        candidates: move.candidates,
        replies,
      };
    }
    const candidates = candidatesFrom(await this.analyse(req.fen));
    if (!candidates.length) throw new AppError('bad-request', 'The game is already over in this position.');
    return { ...ask, candidates };
  }
}
