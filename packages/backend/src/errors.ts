import type { ErrorCode } from '@chess-coach/shared/protocol';

/** An error whose message is written for the Player and safe to send to clients. */
export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
