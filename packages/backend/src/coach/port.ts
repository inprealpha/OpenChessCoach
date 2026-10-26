// The Coach port: the backend sends a brief and gets back a streamed explanation plus
// structured data. Two implementations: the real Coach and the fake Coach (ADR 0006).
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { CoachJob, CoachStatus } from '@chess-coach/shared/protocol';

export interface CoachCall {
  job: CoachJob;
  model: string;
  brief: Brief;
  signal?: AbortSignal;
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
