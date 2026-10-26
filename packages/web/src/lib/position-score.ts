// The evaluation of the position on the board, for the Winning Chances bar on the Board and
// in Engine Games: from the browser Engine's analysis (ADR 0007). A Review reads its own graded
// moves instead, with `scoreAfterPly` from the shared package, so reopening one runs no Engine.
import { turnOf } from '@chess-coach/shared/chess';
import type { Analysis } from '@chess-coach/shared/engine';
import { finishedScore, type PositionScore } from '@chess-coach/shared/position-score';

/** From the Engine's analysis of `fen`; null while the Engine hasn't reported on it. */
export function scoreFromAnalysis(fen: string, analysis: Analysis | null): PositionScore | null {
  const done = finishedScore(fen);
  if (done) return done;
  const best = analysis?.fen === fen ? analysis.lines[0] : undefined;
  return best ? { score: best.score, pov: turnOf(fen) } : null;
}
