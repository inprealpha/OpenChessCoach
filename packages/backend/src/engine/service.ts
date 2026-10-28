// The desktop's Engine (ADR 0007): it grades games for Reviews, grades Lesson turns, and computes
// every Engine fact in a Coach brief, so the Coach move guard checks the Coach against facts the
// backend produced, never facts a client sent. Each position is analysed once.
import { candidatesFrom, gradeFromAnalyses, gradeGame, type Candidate, type GradedMove } from '@chess-coach/shared/analysis';
import { INITIAL_FEN, isValidFen, outcomeOf, playLine, playSan, playUci, sansIn, turnOf, type Side } from '@chess-coach/shared/chess';
import type { CoachAsk, CoachRequest } from '@chess-coach/shared/coach/types';
import type { Analysis, Engine } from '@chess-coach/shared/engine';
import { findThreat, type Threat } from '@chess-coach/shared/threat';
import { AppError } from '../errors.ts';

export interface EngineSettings {
  depth: number;
  multiPv: number;
}

const CACHE_SIZE = 2000;
/** How many moves a Why Question may name for the brief, each costing one search when it isn't a candidate. */
const MAX_ASKED = 2;

/**
 * The moves a question names that are legal in `fen`, besides `moveUci`, at most MAX_ASKED, in UCI.
 * Unless `moveUci` is the Player's own, a move that could also be played right after it is left
 * out: "Why not Nd4?" could then mean either side's move, and a wrong guess explains the wrong one.
 */
function namedMoves(fen: string, question: string, moveUci: string | undefined, playerSide: Side | undefined): string[] {
  const next = moveUci && turnOf(fen) !== playerSide ? playUci(fen, moveUci)?.fenAfter : undefined;
  const out: string[] = [];
  for (const san of sansIn(question, { pushes: true })) {
    const uci = playSan(fen, san)?.uci;
    if (uci && uci !== moveUci && !out.includes(uci) && !(next && playSan(next, san))) out.push(uci);
    if (out.length === MAX_ASKED) break;
  }
  return out;
}

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

  /**
   * The Engine's top lines in a position, at the configured depth. Fewer lines than configured are
   * cached apart, so they are never served as a position's candidates.
   */
  async analyse(fen: string, multiPv = this.settings.multiPv): Promise<Analysis> {
    if (!isValidFen(fen)) throw new AppError('bad-request', 'The position is not valid.');
    if (outcomeOf(fen)) return { fen, depth: 0, lines: [] };
    const key = multiPv === this.settings.multiPv ? fen : `${fen}|${multiPv}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const analysis = this.get().then((e) => e.analyse(fen, { multiPv, depth: this.settings.depth }));
    this.cache.set(key, analysis);
    analysis.catch(() => this.cache.delete(key));
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return analysis;
  }

  /**
   * The opponent's threat in a position, from the cached analyses at the configured depth: a
   * position the desktop already analysed, as every position of a graded game is, costs only the
   * one-line search after the null move.
   */
  async threat(fen: string): Promise<Threat | undefined> {
    if (!isValidFen(fen)) throw new AppError('bad-request', 'The position is not valid.');
    return findThreat((f, multiPv) => this.analyse(f, multiPv), fen);
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
    // Trimmed, as the handler measures it, so a question padded with spaces costs no more to read.
    const question = typeof req.question === 'string' ? req.question.trim() : '';
    const ask: CoachAsk = {
      job: req.job,
      fen: req.fen,
      recentMoves: Array.isArray(req.recentMoves) ? req.recentMoves.filter((m) => typeof m === 'string') : [],
      candidates: [],
      ...(req.threadId ? { threadId: req.threadId } : {}),
      ...(req.playerSide === 'white' || req.playerSide === 'black' ? { playerSide: req.playerSide } : {}),
      ...(question ? { question } : {}),
      ...(req.lesson !== undefined ? { lesson: lessonOf(req.lesson) } : {}),
      ...(typeof req.opening === 'string' ? { opening: req.opening } : {}),
      ...(req.hideWinningChances === true ? { hideWinningChances: true } : {}),
    };
    // The opponent's threat in the position: it reuses the analysis of `fen` and costs one
    // more search, after the null move. After a move, the brief keeps it only when the Engine's
    // best reply to the move is that threat.
    const threat = this.threat(req.fen);
    if (req.moveUci) {
      const [{ move, replies }, found] = await Promise.all([this.grade(req.fen, req.moveUci), threat]);
      const asked = await this.askedIn(ask, move.candidates, move.uci);
      return {
        ...ask,
        move: { uci: move.uci, san: move.san, grade: move.grade, playedScore: move.playedScore },
        candidates: move.candidates,
        ...(asked.length ? { asked } : {}),
        replies,
        ...(found ? { threat: found } : {}),
      };
    }
    const [analysis, found] = await Promise.all([this.analyse(req.fen), threat]);
    const candidates = candidatesFrom(analysis);
    if (!candidates.length) throw new AppError('bad-request', 'The game is already over in this position.');
    const asked = await this.askedIn(ask, candidates);
    return { ...ask, candidates, ...(asked.length ? { asked } : {}), ...(found ? { threat: found } : {}) };
  }

  /**
   * The moves a Why Question names in its position (see `namedMoves`): a candidate as it is, and any
   * other graded as `grade` grades a move, at the cost of one search after it: the search its Move
   * Grade uses if it is played, so the two always agree. Other jobs pay for none.
   */
  private async askedIn(ask: CoachAsk, candidates: readonly Candidate[], moveUci?: string): Promise<Candidate[]> {
    if (ask.job !== 'why' || ask.question === undefined) return [];
    return Promise.all(
      namedMoves(ask.fen, ask.question, moveUci, ask.playerSide).map(async (uci) => {
        const candidate = candidates.find((c) => c.uci === uci);
        return candidate ?? (await this.gradeAsked(ask.fen, uci)).move;
      }),
    );
  }

  /**
   * A move the Coach asks about, as a candidate: scored by the search after it, the search its Move
   * Grade uses if it is played, with the Engine's line there, and the Engine's replies to it.
   */
  async gradeAsked(fen: string, uci: string): Promise<{ move: Candidate; replies: Candidate[] }> {
    const { move, replies } = await this.grade(fen, uci);
    return { move: { uci: move.uci, san: move.san, score: move.playedScore, pv: [move.uci, ...(replies[0]?.pv ?? [])] }, replies };
  }
}
