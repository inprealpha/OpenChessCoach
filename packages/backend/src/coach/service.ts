// Runs one Coach call: fresh brief, budget check, the Engine tool with Think deeper on, Coach
// port, move guard, profile note.
import { assertBriefWithinBudget, BriefTooLargeError, buildBrief, type Brief } from '@chess-coach/shared/coach/brief';
import { ENGINE_TOOL_JOBS } from '@chess-coach/shared/coach/engine-tool';
import { guardReply } from '@chess-coach/shared/coach/guard';
import type { CoachAsk, CoachReply } from '@chess-coach/shared/coach/types';
import { modelJobOf, type CoachStatus } from '@chess-coach/shared/protocol';
import { type Clock, iso } from '../clock.ts';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import { addCoachNote, getProfile } from '../profile.ts';
import type { EngineService } from '../engine/service.ts';
import { getSettings } from '../settings.ts';
import { EngineTool, type EngineCall } from './engine-tool.ts';
import { CoachDeadlineError, CoachLimitError, CoachUnavailableError, type CoachPort } from './port.ts';

/** How the Coach panel says the Coach is asking the Engine, numbered so the Player sees it move on. */
export function checkingText(n: number): string {
  return `The Coach is checking with the Engine (question ${n})…`;
}

/** What a Coach call may use besides its ask. */
export interface AskOptions {
  signal?: AbortSignal;
  /** The desktop's Engine, which the Coach may ask with Think deeper on (ADR 0010). */
  engine?: EngineService;
  /** Hears what the Coach is doing while no text streams, such as asking the Engine. */
  onStatus?: (status: string) => void;
  /** With the Engine, a shorter deadline than the Coach's own, when a Review has less time left. */
  deadlineMs?: number;
  /** With the Engine, answer once more from the brief alone when the deadline stops the call. */
  retryWithoutEngine?: boolean;
}

const MAX_THREADS = 200;
const MAX_LOGGED_CALLS = 500;
/** Clears the questions of Coach calls older than the oldest one kept (the parameter), through the index on call_id. */
export const QUESTION_CLEANUP = 'DELETE FROM coach_questions WHERE call_id < ?';
/** The same for the tempting moves logged with each call (ADR 0011). */
export const TEMPTING_CLEANUP = 'DELETE FROM coach_tempting WHERE call_id < ?';

export class CoachService {
  private readonly db: Db;
  private readonly clock: Clock;
  readonly coach: CoachPort;
  private readonly threads = new Map<string, string>();
  private limitUntil: Date | undefined;
  private unavailableReason: string | undefined;
  private readonly onStatus: (status: CoachStatus) => void;

  constructor(db: Db, clock: Clock, coach: CoachPort, onStatus: (status: CoachStatus) => void = () => {}) {
    this.db = db;
    this.clock = clock;
    this.coach = coach;
    this.onStatus = onStatus;
  }

  async status(): Promise<CoachStatus> {
    if (this.limitUntil && this.limitUntil > this.clock.now()) {
      return { state: 'limit-reached', reason: limitMessage(this.limitUntil) };
    }
    if (this.unavailableReason) return { state: 'unavailable', reason: this.unavailableReason };
    return this.coach.status();
  }

  setUnavailable(reason: string | undefined): void {
    this.unavailableReason = reason;
  }

  /** Throws the Player-facing reason when the Coach can't answer right now. */
  async assertAvailable(): Promise<void> {
    const status = await this.status();
    if (status.state === 'limit-reached') throw new AppError('coach-limit', status.reason ?? 'Your Claude usage limit has been reached.');
    if (status.state === 'unavailable') throw new AppError('coach-unavailable', status.reason ?? 'The Coach is unavailable.');
  }

  /**
   * Asks the Coach. Every Engine fact in `ask` comes from the desktop's Engine (ADR 0007). With
   * Think deeper on, a Why Question or a Review moment may also ask `options.engine` while it answers (ADR 0010).
   */
  async ask(ask: CoachAsk, onText: (delta: string) => void, options: AskOptions = {}): Promise<CoachReply> {
    await this.assertAvailable();

    const brief = this.brief(ask);
    const settings = getSettings(this.db);
    const model = settings.models[modelJobOf(ask.job)];
    const { engine, signal } = options;
    // The tool's Engine searches end with the call: when the client cancels, and once the Coach is done or stopped.
    const stop = new AbortController();
    const cancel = () => stop.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const tool =
      engine && settings.thinkDeeper && ENGINE_TOOL_JOBS.includes(ask.job)
        ? new EngineTool(engine, brief.fen, { signal: stop.signal, onQuestion: (n) => options.onStatus?.(checkingText(n)) })
        : undefined;
    let raw;
    try {
      raw = await this.coach.ask(
        {
          job: ask.job,
          model,
          brief,
          ...(signal ? { signal } : {}),
          ...(tool ? { engine: tool, ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) } : {}),
        },
        onText,
      );
    } catch (err) {
      if (err instanceof CoachLimitError) {
        this.log(ask, model, brief, null, [], tool?.calls);
        this.limitUntil = err.resetsAt ?? new Date(this.clock.now().getTime() + 15 * 60_000);
        const next = await this.status();
        this.onStatus(next);
        throw new AppError('coach-limit', next.reason ?? err.message);
      }
      if (err instanceof CoachUnavailableError) {
        this.log(ask, model, brief, null, [], tool?.calls);
        this.onStatus({ state: 'unavailable', reason: err.message });
        throw new AppError('coach-unavailable', err.message);
      }
      this.log(ask, model, brief, null, [], tool?.calls);
      // Out of time with the Engine: once, the Coach answers from the brief alone instead.
      if (err instanceof CoachDeadlineError && options.retryWithoutEngine) return this.ask(ask, onText, { ...options, engine: undefined });
      throw new AppError('coach-error', `The Coach couldn't answer: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      stop.abort();
      signal?.removeEventListener('abort', cancel);
    }
    if (!raw.text.trim()) {
      this.log(ask, model, brief, raw, [], tool?.calls);
      throw new AppError('coach-error', 'The Coach couldn’t answer: its reply was empty. Try asking again.');
    }
    // Moves the Engine's answers gave the Coach count as Engine output; a move it made up is still stripped.
    const guarded = guardReply(brief, raw, tool?.moves);
    this.log(ask, model, brief, raw, guarded.stripped, tool?.calls);
    const note = guarded.note ? addCoachNote(this.db, this.clock, guarded.note) : null;
    if (ask.threadId) this.remember(ask.threadId, ask.question, raw.text);
    return {
      text: raw.text,
      moves: guarded.moves,
      arrows: guarded.arrows,
      highlights: guarded.highlights,
      note,
      stripped: guarded.stripped.length,
      model,
      engineQuestions: tool?.questions ?? 0,
    };
  }

  /** Builds and checks the brief exactly as a Coach call would. */
  brief(ask: CoachAsk): Brief {
    try {
      const brief = buildBrief({
        ask,
        profile: getProfile(this.db),
        ...(ask.threadId && this.threads.has(ask.threadId) ? { summary: this.threads.get(ask.threadId) as string } : {}),
      });
      assertBriefWithinBudget(brief);
      return brief;
    } catch (err) {
      if (err instanceof BriefTooLargeError) throw new AppError('brief-too-large', err.message);
      throw err;
    }
  }

  /** Follow-ups are carried by a short summary, never the full history (ADR 0004). */
  private remember(threadId: string, question: string | undefined, answer: string): void {
    const turn = `${question ? `Player asked: ${question.slice(0, 120)}. ` : ''}Coach said: ${answer.slice(0, 160)}`;
    const previous = this.threads.get(threadId);
    const summary = previous ? `${previous} | ${turn}` : turn;
    this.threads.delete(threadId);
    this.threads.set(threadId, summary.slice(-600));
    if (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value as string);
  }

  private log(ask: CoachAsk, model: string, brief: Brief, raw: unknown, stripped: string[], engineCalls: readonly EngineCall[] = []): void {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO coach_calls (coach, job, model, brief, raw_reply, stripped, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.coach.name, ask.job, model, JSON.stringify(brief), raw ? JSON.stringify(raw) : null, JSON.stringify(stripped), iso(this.clock));
    // Where the tempting moves came from, and what an Opus guess cost on top of the call (ADR 0011).
    const t = ask.temptingFrom;
    if (t) {
      this.db
        .prepare('INSERT INTO coach_tempting (call_id, source, moves, ms, usage) VALUES (?, ?, ?, ?, ?)')
        .run(lastInsertRowid, t.source, JSON.stringify(t.moves), t.ms, t.usage ? JSON.stringify(t.usage) : null);
    }
    const question = this.db.prepare('INSERT INTO coach_questions (call_id, question, answer, refused, ms) VALUES (?, ?, ?, ?, ?)');
    for (const c of engineCalls) {
      question.run(lastInsertRowid, JSON.stringify(c.question), c.answer ? JSON.stringify(c.answer) : null, c.refused ?? null, c.ms);
    }
    const trimmed = this.db
      .prepare('DELETE FROM coach_calls WHERE id NOT IN (SELECT id FROM coach_calls ORDER BY id DESC LIMIT ?)')
      .run(MAX_LOGGED_CALLS);
    // Only once calls were trimmed: most calls trim nothing and ask the Engine nothing.
    if (trimmed.changes) {
      const oldest = this.db.prepare('SELECT MIN(id) AS id FROM coach_calls').get() as { id: number };
      this.db.prepare(QUESTION_CLEANUP).run(oldest.id);
      this.db.prepare(TEMPTING_CLEANUP).run(oldest.id);
    }
  }
}

function limitMessage(until: Date): string {
  const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Your Claude usage limit has been reached. The Coach is back after ${time}.`;
}
