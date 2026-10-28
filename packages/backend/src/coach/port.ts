// The Coach port: the backend sends a brief and gets back a streamed explanation plus
// structured data. Two implementations: the real Coach and the fake Coach (ADR 0006).
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { EngineQuestion } from '@chess-coach/shared/coach/engine-tool';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { CoachJob, CoachStatus } from '@chess-coach/shared/protocol';

export interface CoachCall {
  job: CoachJob;
  model: string;
  brief: Brief;
  signal?: AbortSignal;
  /** With Think deeper on, the desktop's Engine, which the Coach may ask while it answers (ADR 0010). */
  engine?: CoachEngine;
  /** With the Engine, how long the call may take: the Coach's own default, or less when a Review has less left. */
  deadlineMs?: number;
}

/** The one tool the Coach can be given: questions to the desktop's Engine, answered as text for the Coach to read. */
export interface CoachEngine {
  readonly maxQuestions: number;
  /** How many calls the tool takes in all, refused ones included: the turns the Coach needs for them. */
  readonly maxCalls: number;
  /** Whether every further question would be refused, so the Coach's next turn is its answer. */
  readonly exhausted: boolean;
  ask(question: EngineQuestion): Promise<{ text: string; refused: boolean }>;
}

export interface CoachPort {
  readonly name: 'real' | 'fake';
  ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply>;
  status(): Promise<CoachStatus>;
}

/** The owner's Claude limits are used up. */
export class CoachLimitError extends Error {
  readonly resetsAt: Date | undefined;
  constructor(message: string, resetsAt?: Date) {
    super(message);
    this.resetsAt = resetsAt;
  }
}

/** The Coach can't be reached at all, for example because Claude Code is logged out. */
export class CoachUnavailableError extends Error {}

/** A call with the Engine tool reached its deadline and was stopped (ADR 0010). */
export class CoachDeadlineError extends Error {
  constructor(ms: number) {
    super(`thinking deeper took longer than ${Math.round(ms / 1000)} seconds, so it stopped. Ask again, or turn Think deeper off in Settings.`);
  }
}
