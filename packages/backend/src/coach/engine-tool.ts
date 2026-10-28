// The Engine as the Coach's one tool, with Think deeper on (ADR 0010). Each Coach call gets its
// own, bound to its brief's position: it answers at most MAX_ENGINE_QUESTIONS questions from the
// desktop's Engine, and keeps every move its answers gave, which the move guard then accepts as
// Engine output. A client never reaches it: only the backend builds it, from its own Engine (ADR 0007).
import { candidatesFrom } from '@chess-coach/shared/analysis';
import {
  answerMoves,
  engineAnswer,
  MAX_ENGINE_QUESTIONS,
  placeQuestion,
  QuestionError,
  type EngineAnswer,
  type EngineMove,
  type EngineQuestion,
} from '@chess-coach/shared/coach/engine-tool';
import type { EngineService } from '../engine/service.ts';
import type { CoachEngine } from './port.ts';

/** One question as the call log keeps it: what the Coach asked, and the Engine's answer or why it was refused. */
export interface EngineCall {
  question: EngineQuestion;
  answer?: EngineAnswer;
  refused?: string;
  ms: number;
}

export class EngineTool implements CoachEngine {
  readonly maxQuestions = MAX_ENGINE_QUESTIONS;
  /** Every question, in the order asked. */
  readonly calls: EngineCall[] = [];
  /** Every move the Engine's answers gave the Coach, with the position it is played in. */
  readonly moves: EngineMove[] = [];
  private readonly engine: EngineService;
  private readonly fen: string;
  private answered = 0;

  constructor(engine: EngineService, fen: string) {
    this.engine = engine;
    this.fen = fen;
  }

  /** How many questions the Engine answered. */
  get questions(): number {
    return this.answered;
  }

  async ask(question: EngineQuestion): Promise<{ text: string; refused: boolean }> {
    const started = Date.now();
    const refuse = (reason: string) => {
      this.calls.push({ question, refused: reason, ms: Date.now() - started });
      return { text: reason, refused: true };
    };
    // Counted before the search, so questions asked at once can't slip past the cap together.
    if (this.answered >= this.maxQuestions) {
      return refuse(`You have asked the Engine ${this.maxQuestions} times, the most for one answer. Answer now from the brief and the Engine's answers so far.`);
    }
    let placed;
    try {
      placed = placeQuestion(this.fen, question);
    } catch (err) {
      if (err instanceof QuestionError) return refuse(err.message);
      throw err;
    }
    this.answered++;
    const left = this.maxQuestions - this.answered;
    const [analysis, asked] = await Promise.all([
      this.engine.analyse(placed.fen),
      placed.move ? this.engine.gradeAsked(placed.fen, placed.move.uci) : undefined,
    ]);
    const candidates = candidatesFrom(analysis);
    // A move the Engine listed is graded as it is, as a brief grades a candidate the Player asks about.
    const listed = placed.move && candidates.find((c) => c.uci === placed.move?.uci);
    const answer = engineAnswer(placed, candidates, asked && { move: listed ?? asked.move, replies: asked.replies }, left);
    this.moves.push(...answerMoves(answer));
    this.calls.push({ question, answer, ms: Date.now() - started });
    return { text: JSON.stringify(answer), refused: false };
  }
}
