// What clients send when they want the Coach, and what they get back after the guard.
import type { Candidate } from '../analysis.ts';
import type { Side } from '../chess.ts';
import type { Score } from '../engine.ts';
import type { MoveGrade } from '../grader.ts';
import type { PositionScore } from '../position-score.ts';
import type { CoachJob, GradeCounts, ModelJob } from '../protocol.ts';
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
  /** A Review's overview is never asked for by a client: the desktop makes it from its own Review. */
  job: ModelJob;
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
  /** Sent with every Coach call during a Lesson (ADR 0012). */
  lessonFocus?: CoachAsk['lessonFocus'];
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

/** A move of a reviewed game, as a Review's overview names it. */
export interface GameMoveFact {
  ply: number;
  side: Side;
  uci: string;
  san: string;
  /** As a scoresheet writes it: "11. Bxf7+", "24… Nxf2". */
  label: string;
  grade: MoveGrade;
}

/**
 * A Review's overview: the whole game from the Review's own graded moves, not one position. Every
 * move in it was graded by the desktop's Engine (ADR 0007), and only the desktop sets it.
 */
export interface GameFacts {
  opening: string;
  result: string;
  /** The Move Grade counts of each side's moves. */
  grades: Record<Side, GradeCounts>;
  /** The key moments the Review walks through next, each with the Engine's best move instead. */
  moments: (GameMoveFact & { better?: { uci: string; san: string } })[];
  /** The moves that stood out on both sides, other than the key moments (see `pickStandouts`). */
  standouts: (GameMoveFact & { only: boolean })[];
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
  /**
   * The tempting moves in `fen` (ADR 0011): the moves many players at the Player's level would reach
   * for there, from Maia-3 (or Opus until its model is downloaded), each graded by the desktop's
   * Engine as an asked move is: a candidate as it is, any other with its score and the Engine's line
   * after it. Only the desktop sets them.
   */
  tempting?: Candidate[];
  /** Where the tempting moves came from and what that cost, for the call log; never in the brief. */
  temptingFrom?: { source: 'maia' | 'opus' | 'fake'; moves: string[]; ms: number; usage?: CoachUsage };
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
    /**
     * Whether the move is the one the Lesson teaches at this decision. When it is not, the Player
     * may try again, so the brief keeps back the Lesson's move and the Engine's best move, as a
     * Hint keeps back every move: no candidates, no notes, and only the move's own popularity.
     * A client that doesn't send it gets the brief as before.
     */
    isLessonMove?: boolean;
  };
  /**
   * During a Lesson, on every Coach call (a Lesson turn, a Hint, a Why Question): the Lesson's name,
   * its learning goal and the current part's key idea, so the Coach stays on the Lesson's point
   * (ADR 0012). The brief's `focus` uses the same names.
   */
  lessonFocus?: { lesson: string; learningGoal: string; keyIdea: string };
  /** Opening or theme, used to pick the relevant slice of the Player Profile. */
  opening?: string;
  /** For Reviews: the overview, or the last moment without one, may carry a profile note. */
  allowNote?: boolean;
  /** For a Review's overview: the whole game. */
  game?: GameFacts;
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
  /** The SDK's estimate of what the call would cost at API prices, in US dollars. */
  costUsd: number;
  /** The exact models the call ran on, as the model alias resolved. */
  models: string[];
}

/** What clients receive: the guarded reply. */
export interface CoachReply {
  text: string;
  /** Every move the Coach shows, in UCI, each one checked against the Engine's output. */
  moves: string[];
  arrows: Arrow[];
  highlights: string[];
  /** The note saved to the Player Profile, if any (or, for a Review, the one it saves with itself). */
  note: string | null;
  /** How many moves or arrows the guard removed. */
  stripped: number;
  model: string;
  /** How many questions the Coach asked the Engine while it answered, with Think deeper on (ADR 0010). */
  engineQuestions: number;
}
