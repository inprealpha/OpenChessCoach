// Runs one Coach call: fresh brief, budget check, the Engine tool with Think deeper on, Coach
// port, move guard, profile note.
import { assertBriefWithinBudget, BriefTooLargeError, buildBrief, type Brief } from '@chess-coach/shared/coach/brief';
import { ENGINE_TOOL_JOBS } from '@chess-coach/shared/coach/engine-tool';
import { guardReply } from '@chess-coach/shared/coach/guard';
import type { CoachAsk, CoachReply } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { type Clock, iso } from '../clock.ts';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import { addCoachNote, getProfile } from '../profile.ts';
import type { EngineService } from '../engine/service.ts';
import { getSettings } from '../settings.ts';
import { EngineTool, type EngineCall } from './engine-tool.ts';
import { CoachLimitError, CoachUnavailableError, type CoachPort } from './port.ts';

const MAX_THREADS = 200;
const MAX_LOGGED_CALLS = 500;

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
   * Think deeper on, a Why Question or a Review moment may also ask `engine` while it answers (ADR 0010).
   */
  async ask(ask: CoachAsk, onText: (delta: string) => void, signal?: AbortSignal, engine?: EngineService): Promise<CoachReply> {
    await this.assertAvailable();

    const brief = this.brief(ask);
    const settings = getSettings(this.db);
    const model = settings.models[ask.job];
    const tool = engine && settings.thinkDeeper && ENGINE_TOOL_JOBS.includes(ask.job) ? new EngineTool(engine, brief.fen) : undefined;
    let raw;
    try {
      raw = await this.coach.ask({ job: ask.job, model, brief, ...(signal ? { signal } : {}), ...(tool ? { engine: tool } : {}) }, onText);
    } catch (err) {
      if (err instanceof CoachLimitError) {
        this.limitUntil = err.resetsAt ?? new Date(this.clock.now().getTime() + 15 * 60_000);
        const next = await this.status();
        this.onStatus(next);
        throw new AppError('coach-limit', next.reason ?? err.message);
      }
      if (err instanceof CoachUnavailableError) {
        this.onStatus({ state: 'unavailable', reason: err.message });
        throw new AppError('coach-unavailable', err.message);
      }
      this.log(ask.job, model, brief, null, [], tool?.calls);
      throw new AppError('coach-error', `The Coach couldn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!raw.text.trim()) {
      this.log(ask.job, model, brief, raw, [], tool?.calls);
      throw new AppError('coach-error', 'The Coach couldn’t answer: its reply was empty. Try asking again.');
    }
    // Moves the Engine's answers gave the Coach count as Engine output; a move it made up is still stripped.
    const guarded = guardReply(brief, raw, tool?.moves);
    this.log(ask.job, model, brief, raw, guarded.stripped, tool?.calls);
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

  private log(job: string, model: string, brief: Brief, raw: unknown, stripped: string[], engineCalls: readonly EngineCall[] = []): void {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO coach_calls (coach, job, model, brief, raw_reply, stripped, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.coach.name, job, model, JSON.stringify(brief), raw ? JSON.stringify(raw) : null, JSON.stringify(stripped), iso(this.clock));
    const ask = this.db.prepare('INSERT INTO coach_questions (call_id, question, answer, refused, ms) VALUES (?, ?, ?, ?, ?)');
    for (const c of engineCalls) {
      ask.run(lastInsertRowid, JSON.stringify(c.question), c.answer ? JSON.stringify(c.answer) : null, c.refused ?? null, c.ms);
    }
    this.db
      .prepare('DELETE FROM coach_calls WHERE id NOT IN (SELECT id FROM coach_calls ORDER BY id DESC LIMIT ?)')
      .run(MAX_LOGGED_CALLS);
    this.db.prepare('DELETE FROM coach_questions WHERE call_id NOT IN (SELECT id FROM coach_calls)').run();
  }
}

function limitMessage(until: Date): string {
  const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Your Claude usage limit has been reached. The Coach is back after ${time}.`;
}
