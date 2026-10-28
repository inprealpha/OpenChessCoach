// What clients send when they want the Coach, and what they get back after the guard.
import type { Candidate } from '../analysis.ts';
import type { Side } from '../chess.ts';
import type { Score } from '../engine.ts';
import type { MoveGrade } from '../grader.ts';
import type { PositionScore } from '../position-score.ts';
import type { CoachJob } from '../protocol.ts';
import type { Threat } from '../threat.ts';

export type Brush = 'green' | 'blue' | 'red' | 'yellow';

export interface Arrow {
  from: string;
  to: string;
  brush: Brush;
}

/**
 * What a client sends when it wants the Coach: the position and the moves played, never Engine
 * findings. The desktop's Engine computes every fact in the brief (ADR 0007).
 */
export interface CoachRequest {
  job: CoachJob;
  /** Follow-up questions in the same thread share a short summary, never the full history. */
  threadId?: string;
  /** The position under discussion: before the move, if there is one. */
  fen: string;
  /** SAN moves that led to `fen`. The brief keeps only the most recent. */
  recentMoves: string[];
  playerSide?: Side;
  /** The move under discussion, in UCI, played from `fen`. */
  moveUci?: string;
  /** The Player's question or typed answer. */
  question?: string;
  /** Lesson context: bundled notes and how often players at the Player's level choose each move. */
  lesson?: CoachAsk['lesson'];
  /** Opening or theme, used to pick the relevant slice of the Player Profile. */
  opening?: string;
  /**
   * The game a Review's Why Question is about: the desktop then scores the positions either side of
   * the move from that Review's graded moves, as the Review shows them.
   */
  gameId?: number;
  /**
   * The screen hides the Winning Chances bar so it doesn't give the answer away, as a Lesson and a
   * Puzzle do: the brief then leaves them out as well.
   */
  hideWinningChances?: boolean;
}

/** A Coach request with the desktop Engine's facts added. Every chess fact in it comes from the Engine (ADR 0002). */
export interface CoachAsk {
  job: CoachJob;
  /** Follow-up questions in the same thread share a short summary, never the full history. */
  threadId?: string;
  /** The position the candidates were computed in: before the move under discussion, if there is one. */
  fen: string;
  /** SAN moves that led to `fen`. The brief keeps only the most recent. */
  recentMoves: string[];
  playerSide?: Side;
  /** The move under discussion, played from `fen`. */
  move?: { uci: string; san: string; grade: MoveGrade; playedScore: Score };
  /** The Engine's candidate moves in `fen`, best first. */
  candidates: Candidate[];
  /**
   * The moves in `fen` a Why Question names, besides the move: a candidate as it is, and any other
   * graded by the desktop's Engine as it grades a move, with its score for the side that plays it
   * and the Engine's line after it. Only the desktop sets them.
   */
  asked?: Candidate[];
  /**
   * The scores the screen shows for `fen` and for the position after `move` when they aren't the
   * Engine's best line there: a Review scores each position with the graded move that led to it
   *. Only the desktop sets them.
   */
  positionBefore?: PositionScore;
  positionAfter?: PositionScore;
  /** The Engine's candidate replies after `move`, best first. */
  replies?: Candidate[];
  /** What the opponent threatens in `fen`, when the Engine finds a real threat. Only the desktop sets it. */
  threat?: Threat;
  /** The Player's question or typed answer. */
  question?: string;
  /** Lesson context: bundled notes and how often players at the Player's level choose each move. */
  lesson?: {
    lessonId: string;
    /** The Lesson's name: an opening, a Theme or an endgame. */
    opening: string;
    notes: string;
    popularity: { san: string; percent: number }[];
    finalTurn: boolean;
  };
  /** Opening or theme, used to pick the relevant slice of the Player Profile. */
  opening?: string;
  /** For Reviews: the last moment may carry a profile note. */
  allowNote?: boolean;
  /** The screen hides the Winning Chances bar (a Lesson or a Puzzle), so the brief leaves them out. */
  hideWinningChances?: boolean;
}

/** What a Coach implementation returns before the guard. Moves are always data, never only prose. */
export interface CoachRawReply {
  text: string;
  moves: string[];
  arrows: { uci: string; brush: Brush }[];
  highlights: string[];
  note: string | null;
  /** What the call cost, when the Coach reports it. Logged, never shown. */
  usage?: CoachUsage;
}

/** One Coach call's cost: tokens, turns and time, as the Claude Agent SDK reports them. */
export interface CoachUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  ms: number;
}

/** What clients receive: the guarded reply. */
export interface CoachReply {
  text: string;
  /** Every move the Coach shows, in UCI, each one checked against the Engine's output. */
  moves: string[];
  arrows: Arrow[];
  highlights: string[];
  /** The note saved to the Player Profile, if any. */
  note: string | null;
  /** How many moves or arrows the guard removed. */
  stripped: number;
  model: string;
  /** How many questions the Coach asked the Engine while it answered, with Think deeper on (ADR 0010). */
  engineQuestions: number;
}
