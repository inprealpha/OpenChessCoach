// The Engine as a tool the Coach can ask while it answers, when the Player turns on "Think
// deeper" (ADR 0010). The Coach names a position by a line of moves from its brief's position,
// and optionally one move there; the desktop's Engine answers with what a brief would say about
// them: Move Grades, lines and the explainability layer's facts, so the Coach still never works
// the chess out itself (ADR 0002, ADR 0009). This file turns the Engine's lines into that answer.
import type { Candidate } from '../analysis.ts';
import { outcomeOf, playSan, playUci, SIDE_NAMES, turnOf, type Side } from '../chess.ts';
import type { CoachJob } from '../protocol.ts';
import { negateScore } from '../grader.ts';
import { briefCandidates, explained, type BriefCandidate, type Facts } from './brief.ts';

/** The Coach jobs that may ask the Engine. Hints and Live Coaching must stay short; Lessons have their own notes. */
export const ENGINE_TOOL_JOBS: readonly CoachJob[] = ['why', 'review-moment'];
/** How many questions one Coach answer may ask the Engine. A question past it is refused, and the Coach answers. */
export const MAX_ENGINE_QUESTIONS = 3;
/**
 * How many more calls the tool takes besides those, for questions it refuses (an illegal move, an
 * Engine that can't answer), which don't count as questions. Every call is a turn of the Coach's.
 */
export const MAX_REFUSED_QUESTIONS = 2;
/** The longest line a question may play from the brief's position, in plies. */
export const MAX_QUESTION_PLIES = 10;
const ANSWER_CANDIDATES = 3;
const ANSWER_REPLIES = 2;

/** What the Coach asks: the position after `line` (SAN moves from the brief's `fen`), and optionally one `move` there. */
export interface EngineQuestion {
  line?: string[];
  move?: string;
}

/** A question checked against the board: the position it names and the move, both legal. */
export interface PlacedQuestion {
  /** The line as the board plays it, in SAN. */
  line: string[];
  fen: string;
  move?: { uci: string; san: string };
  /** The line's last move, and the position it is played in. */
  last?: { fen: string; uci: string; san: string };
}

/** The Engine's answer, worded like a brief so the Coach reads it the same way. */
export interface EngineAnswer {
  /** The position asked about, as moves from the brief's position. */
  after: string;
  fen: string;
  sideToMove: Side;
  /** The game is over in the position: then there are no candidates. */
  over?: string;
  /**
   * What the last move of the line does, as the brief says what the Player's move does: read off
   * the board, and along the Engine's best line after it for "result". A candidate's facts are
   * about that candidate only.
   */
  lastMove?: { san: string } & Facts;
  /** The Engine's best moves there, each graded against its best, with its line and facts. */
  candidates: BriefCandidate[];
  /** The move asked about: its Move Grade against the Engine's best move there, its line, its facts and the Engine's replies to it. */
  move?: BriefCandidate & { replies: BriefCandidate[] };
  /** How many more questions this answer may ask. */
  questionsLeft: number;
}

/** A move the Engine's answer contains, and the position it is played in. The guard checks Coach moves against these. */
export interface EngineMove {
  fen: string;
  uci: string;
}

export class QuestionError extends Error {}

/**
 * Checks a question against the board: every move of the line must be legal where it is played,
 * and so must the move. Throws a QuestionError the Coach can read and act on otherwise.
 */
export function placeQuestion(fen: string, question: EngineQuestion): PlacedQuestion {
  const line = question.line ?? [];
  if (!Array.isArray(line) || !line.every((m) => typeof m === 'string')) throw new QuestionError('line must be a list of SAN moves.');
  if (line.length > MAX_QUESTION_PLIES) throw new QuestionError(`A line can be at most ${MAX_QUESTION_PLIES} moves long.`);
  let current = fen;
  const played: string[] = [];
  let last: PlacedQuestion['last'];
  for (const san of line) {
    const move = playSan(current, san.trim());
    if (!move) {
      const where = played.length ? `after ${played.join(' ')}` : 'in the brief’s position';
      throw new QuestionError(`${san} is not a legal move ${where}. Write the line in SAN, from the brief's fen.`);
    }
    last = { fen: current, uci: move.uci, san: move.san };
    played.push(move.san);
    current = move.fenAfter;
  }
  const placed: PlacedQuestion = { line: played, fen: current, ...(last ? { last } : {}) };
  if (question.move === undefined || question.move === '') return placed;
  if (typeof question.move !== 'string') throw new QuestionError('move must be one SAN move.');
  const move = playSan(current, question.move.trim());
  if (!move) {
    const where = played.length ? `after ${played.join(' ')}` : 'in the brief’s position';
    throw new QuestionError(`${question.move} is not a legal move ${where}.`);
  }
  return { ...placed, move: { uci: move.uci, san: move.san } };
}

/**
 * The answer to a placed question from the Engine's lines in its position (`candidates`, best
 * first) and, for a move, `asked`: the move as the desktop grades a move a Why Question names (a
 * candidate as it is, or scored by the search after it with the Engine's line there), and the
 * Engine's `replies` to it. Graded and explained exactly as the brief grades and explains its
 * candidates, an asked move and the replies.
 */
export function engineAnswer(
  placed: PlacedQuestion,
  candidates: readonly Candidate[],
  asked: { move: Candidate; replies: readonly Candidate[] } | undefined,
  questionsLeft: number,
): EngineAnswer {
  const { fen } = placed;
  const answer: EngineAnswer = {
    after: placed.line.length ? placed.line.join(' ') : 'the brief’s position',
    fen,
    sideToMove: turnOf(fen),
    candidates: [],
    questionsLeft,
  };
  if (placed.last) {
    // Scored for the side that played it by the Engine's best line after it, as the brief scores the Player's move.
    const best = candidates[0];
    answer.lastMove = { san: placed.last.san, ...explained(placed.last.fen, placed.last.uci, best?.pv ?? [], best && negateScore(best.score)) };
  }
  const over = outcomeOf(fen);
  if (over) {
    answer.over = over.reason === 'checkmate' && over.winner ? `${SIDE_NAMES[over.winner]} has given mate` : `the game is drawn (${over.reason})`;
    return answer;
  }
  const facts = (from: string) => (c: Candidate) => explained(from, c.uci, c.pv.slice(1), c.score);
  answer.candidates = briefCandidates(fen, candidates, ANSWER_CANDIDATES, facts(fen));
  const [graded] = asked ? briefCandidates(fen, [asked.move], 1, facts(fen), candidates[0]) : [];
  const after = graded && playUci(fen, graded.uci);
  if (graded && after && asked) {
    const replies = briefCandidates(after.fenAfter, asked.replies, ANSWER_REPLIES, (r) => explained(after.fenAfter, r.uci, r.pv.slice(1)));
    answer.move = { ...graded, replies };
  }
  return answer;
}

/**
 * Every move an answer gives the Coach, with the position it is played in: the candidates, the
 * move asked about, the Engine's line after it and its replies. As in a brief, a candidate's
 * line is there to read, not to show.
 */
export function answerMoves(answer: EngineAnswer): EngineMove[] {
  const out: EngineMove[] = answer.candidates.map((c) => ({ fen: answer.fen, uci: c.uci }));
  const after = answer.move && playUci(answer.fen, answer.move.uci);
  if (!answer.move || !after) return out;
  out.push({ fen: answer.fen, uci: after.uci });
  for (const r of answer.move.replies) out.push({ fen: after.fenAfter, uci: r.uci });
  let current = after.fenAfter;
  for (const san of answer.move.line.split(' ').filter(Boolean)) {
    const played = playSan(current, san);
    if (!played) break;
    out.push({ fen: current, uci: played.uci });
    current = played.fenAfter;
  }
  return out;
}
