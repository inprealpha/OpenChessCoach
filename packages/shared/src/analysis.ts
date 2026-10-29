// Grades every move of a game with any Engine implementation.
import { INITIAL_FEN, outcomeOf, outcomeOfLine, playLine, playUci, turnOf, uciToSan, type Outcome, type Side } from './chess.ts';
import type { Analysis, Engine, Score } from './engine.ts';
import { gradeMove, negateScore, type MoveGrade } from './grader.ts';

export interface Candidate {
  uci: string;
  san: string;
  /** Score from the point of view of the side to move in the position the candidate is played from. */
  score: Score;
  /** Principal variation in UCI, starting with the candidate. */
  pv: string[];
}

export interface GradedMove {
  /** 1-based ply number in the game. */
  ply: number;
  side: Side;
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
  grade: MoveGrade;
  winLoss: number;
  /** Score after the played move, from the mover's point of view. */
  playedScore: Score;
  /** The Engine's candidates in the position before the move, best first. */
  candidates: Candidate[];
}

export interface GradeOptions {
  multiPv: number;
  depth: number;
}

export function candidatesFrom(analysis: Analysis): Candidate[] {
  const out: Candidate[] = [];
  for (const line of analysis.lines) {
    const uci = line.pv[0];
    if (!uci) continue;
    const san = uciToSan(analysis.fen, uci);
    if (!san) continue;
    out.push({ uci, san, score: line.score, pv: line.pv });
  }
  return out;
}

/** The game before a move: the position it started from and the moves that led to the move's position. */
export interface GameSoFar {
  startFen: string;
  moves: readonly { fenAfter: string }[];
}

/**
 * Grades one move given the analyses of the positions before and after it. With the game so far,
 * a move that brings a position up a third time is scored as the draw it is: the Engine analyses
 * bare positions, and a position alone doesn't show a repetition.
 */
export function gradeFromAnalyses(
  ply: number,
  uci: string,
  before: Analysis,
  after: Analysis | undefined,
  game?: GameSoFar,
): GradedMove {
  const played = playLine(before.fen, [uci])[0];
  if (!played) throw new Error(`Illegal move ${uci} in ${before.fen}`);
  const ends = (m: { fenAfter: string }): Outcome => (game ? outcomeOfLine(game.startFen, [...game.moves, m]) : outcomeOf(m.fenAfter));
  const candidates = scoringDraws(before.fen, candidatesFrom(before), ends);
  const best = candidates[0];
  if (!best) throw new Error(`No Engine candidates for ${before.fen}`);
  const inCandidates = candidates.find((c) => c.uci === played.uci);
  const outcome = ends(played);
  const playedScore = inCandidates?.score ?? scoreAfterMove(outcome, played.fenAfter, after);
  const givesMate = outcome?.reason === 'checkmate';
  const { grade, winLoss } = gradeMove({ best: best.score, played: playedScore, isTopMove: best.uci === played.uci, givesMate });
  return {
    ply,
    side: turnOf(before.fen),
    uci: played.uci,
    san: played.san,
    fenBefore: before.fen,
    fenAfter: played.fenAfter,
    grade,
    winLoss,
    playedScore,
    candidates,
  };
}

/** The candidates, with any that ends the game in a draw scored as one (its line ends there), best first. */
function scoringDraws(fen: string, candidates: Candidate[], ends: (m: { fenAfter: string }) => Outcome): Candidate[] {
  let changed = false;
  const out = candidates.map((c) => {
    const m = playUci(fen, c.uci);
    const outcome = m && ends(m);
    if (!outcome || outcome.winner) return c;
    changed = true;
    return { ...c, score: { cp: 0 }, pv: [c.uci] };
  });
  // The Engine lists its lines best first; only a rescored one moves.
  return changed ? out.sort((a, b) => scoreOrder(b.score) - scoreOrder(a.score)) : out;
}

/** Orders scores from the side to move's point of view: a mate for it first, sooner first, then centipawns, then a mate against it. */
function scoreOrder(score: Score): number {
  if (score.mate === undefined) return score.cp;
  return score.mate > 0 ? 1e6 - score.mate : -1e6 - score.mate;
}

function scoreAfterMove(outcome: Outcome, fenAfter: string, after: Analysis | undefined): Score {
  if (outcome?.reason === 'checkmate') return { mate: 1 };
  if (outcome) return { cp: 0 };
  const top = after?.lines[0];
  if (!top) throw new Error(`No Engine analysis after the move in ${fenAfter}`);
  return negateScore(top.score);
}

/** Grades every move of a game. Each position is analysed once. */
export async function gradeGame(
  engine: Engine,
  ucis: readonly string[],
  options: GradeOptions,
  startFen: string = INITIAL_FEN,
  onProgress?: (done: number, total: number) => void,
): Promise<GradedMove[]> {
  const line = playLine(startFen, ucis);
  if (line.length !== ucis.length) throw new Error(`Illegal move at ply ${line.length + 1}`);
  const fens = [startFen, ...line.map((m) => m.fenAfter)];
  const analyses: (Analysis | undefined)[] = [];
  for (let i = 0; i < fens.length; i++) {
    const fen = fens[i] as string;
    analyses.push(outcomeOf(fen) ? undefined : await engine.analyse(fen, { multiPv: options.multiPv, depth: options.depth }));
    onProgress?.(i + 1, fens.length);
  }
  const out: GradedMove[] = [];
  for (let i = 0; i < line.length; i++) {
    const before = analyses[i];
    if (!before) break;
    out.push(gradeFromAnalyses(i + 1, (line[i] as { uci: string }).uci, before, analyses[i + 1], { startFen, moves: line.slice(0, i) }));
  }
  return out;
}
