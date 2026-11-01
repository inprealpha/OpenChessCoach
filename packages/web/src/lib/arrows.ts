// The arrows on every board, one colour per meaning (docs/design/interface-guidelines.md, "Arrows
// and marks"): the move played in ink, the Engine's best in green, another good move in blue, a
// threat in dashed red, a move that went wrong in solid red, the opponent's reply in orange. Each keeps its accessible name, and the board
// shows a legend of the colours it draws.
import type { GradedMove } from '@chess-coach/shared/analysis';
import { legalMoves, piecesOf, SIDE_NAMES, turnOf, type Side } from '@chess-coach/shared/chess';
import type { Arrow, Brush } from '@chess-coach/shared/coach/types';
import { nullMoveFen, type Threat } from '@chess-coach/shared/threat';

/** What an arrow means, which picks its colour on every board. */
export type ArrowKind = 'played' | 'best' | 'alt' | 'threat' | 'wrong' | 'reply';

/** An arrow on the board: what it means and its accessible name. */
export interface BoardArrow {
  from: string;
  to: string;
  kind: ArrowKind;
  label: string;
}

/** How each kind of arrow looks, and its word in the legend under the board. */
export const ARROW_LOOK: Record<ArrowKind, { color: string; legend: string; dashed: boolean }> = {
  played: { color: 'var(--arrow-played)', legend: 'played', dashed: false },
  best: { color: 'var(--arrow-best)', legend: 'best', dashed: false },
  alt: { color: 'var(--arrow-alt)', legend: 'other good move', dashed: false },
  threat: { color: 'var(--arrow-threat)', legend: 'threat', dashed: true },
  wrong: { color: 'var(--arrow-threat)', legend: 'went wrong', dashed: false },
  reply: { color: 'var(--arrow-reply)', legend: 'reply', dashed: false },
};

/** The legend's order: the move played first, as it is drawn on top. */
export const ARROW_KINDS: readonly ArrowKind[] = ['played', 'best', 'alt', 'threat', 'wrong', 'reply'];

/**
 * What the Coach's brushes mean (prompts.ts): green the best move, blue another, red a move that
 * went wrong, yellow the opponent's reply. When the move that went wrong is the move played it is
 * drawn in ink, as every move played is.
 */
const BRUSH_KIND: Record<Brush, ArrowKind> = { green: 'best', blue: 'alt', red: 'wrong', yellow: 'reply' };

/**
 * The Coach's arrows on the board. The move that was played (`played`, in UCI) is ink whatever its
 * brush, so it reads the same as on every other board; the rest take their brush's meaning.
 */
export function coachArrows(arrows: readonly Arrow[], played?: string): BoardArrow[] {
  return arrows.map((a) => {
    // A brush the Coach doesn't know, from an older desktop, draws as another move.
    const kind = played && `${a.from}${a.to}` === played.slice(0, 4) ? 'played' : (BRUSH_KIND[a.brush] ?? 'alt');
    return { from: a.from, to: a.to, kind, label: `Arrow ${a.from} to ${a.to} (${ARROW_LOOK[kind].legend})` };
  });
}

/**
 * The threat arrow, when Threat is on and the Engine found one: the opponent's best move if they
 * could move now, dashed red.
 */
export function threatArrows(threat: Pick<Threat, 'side' | 'uci' | 'san'> | null | undefined): BoardArrow[] {
  if (!threat) return [];
  const from = threat.uci.slice(0, 2);
  const to = threat.uci.slice(2, 4);
  return [{ from, to, kind: 'threat', label: `Threat: ${SIDE_NAMES[threat.side]} threatens ${threat.san} (${from} to ${to})` }];
}

/**
 * A Review's arrows for one graded move: the move played, in ink, and the Engine's best in green;
 * one green arrow when they are the same move. Drawn only from what the Review already carries, so
 * they cost no Engine time (ADR 0002).
 */
export function reviewArrows(move: GradedMove | undefined): BoardArrow[] {
  if (!move) return [];
  const best = move.candidates[0];
  const from = move.uci.slice(0, 2);
  const to = move.uci.slice(2, 4);
  if (!best || best.uci === move.uci) {
    const label = `Move played: ${move.san}, ${move.grade}${best ? ', the Engine’s best' : ''}`;
    return [{ from, to, kind: best ? 'best' : 'played', label }];
  }
  return [
    { from, to, kind: 'played', label: `Move played: ${move.san}, ${move.grade}` },
    { from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), kind: 'best', label: `Engine’s best: ${best.san}` },
  ];
}

/**
 * The move that punishes a Blunder or Mistake: the opponent's best reply, dashed red like a threat,
 * so the Blunder pause shows on the board what the move gives away.
 */
export function punishingArrow(uci: string | undefined, san: string | undefined, side: Side): BoardArrow[] {
  if (!uci || !san) return [];
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  return [{ from, to, kind: 'threat', label: `Threat: ${SIDE_NAMES[side]} answers ${san} (${from} to ${to})` }];
}

/**
 * The arrows in the order the board draws them: the move played last, so no other arrow hides it.
 */
export function drawOrder(arrows: readonly BoardArrow[]): BoardArrow[] {
  return [...arrows.filter((a) => a.kind !== 'played'), ...arrows.filter((a) => a.kind === 'played')];
}

/** The legend under a board: the kinds of arrow on it now, in the legend's order. */
export function legendOf(arrows: readonly BoardArrow[]): ArrowKind[] {
  const on = new Set(arrows.map((a) => a.kind));
  return ARROW_KINDS.filter((k) => on.has(k));
}

/**
 * A Lesson's Coach arrows: the move on the board (`played`) and the opponent's moves, never another
 * move for the Player, who plays `player`. Even the Engine's top choice may be the answer to the
 * Lesson's next decision. Only the arrows: the Coach's words may still name other moves (ADR 0012).
 */
export function lessonArrows<A extends { from: string; to: string }>(arrows: readonly A[], fen: string, played: string | undefined, player: Side): A[] {
  const theirs = new Set(piecesOf(fen).filter((p) => p.color !== player).map((p) => p.square));
  return arrows.filter((a) => `${a.from}${a.to}` === played?.slice(0, 4) || theirs.has(a.from));
}

/**
 * A Lesson's Coach highlights, filtered like its arrows (`lessonArrows`): the squares of the move on
 * the board stay, and no square any move of the Player's could go to, which may be where the Lesson's
 * next move goes. After a move that isn't the Lesson's, the Player tries again from `retry`, the
 * position before it, so the squares come from there. When the Player can't be given the move (the
 * opponent is in check), only the move's own squares stay.
 */
export function lessonHighlights(squares: readonly string[], fen: string, played: string | undefined, player: Side, retry?: string): string[] {
  const own = new Set(played ? [played.slice(0, 2), played.slice(2, 4)] : []);
  const playerToMove = retry ?? (turnOf(fen) === player ? fen : nullMoveFen(fen));
  if (!playerToMove) return squares.filter((sq) => own.has(sq));
  const reached = new Set(legalMoves(playerToMove).map((uci) => uci.slice(2, 4)));
  return squares.filter((sq) => own.has(sq) || !reached.has(sq));
}
