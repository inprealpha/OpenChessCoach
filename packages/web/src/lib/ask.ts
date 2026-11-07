// What the Ask box says before the Player types: the move a Why Question would ask about, as a
// scoresheet writes it ("Ask why about 11. Bxf7+"), so the Player knows what the Coach will explain.
import { moveLabel } from '@chess-coach/shared/chess';

/**
 * The Ask box's placeholder for a question about `move`, or about the position when there is none.
 * `short` is for a phone, where the box sits between the step buttons and a 16 px "Ask why about
 * 30. fxe8=Q#" is wider than the box at 390 px: "Why 30. fxe8=Q#?" says the same and fits.
 */
export function askAbout(move: { fenBefore: string; san: string } | undefined, short = false): string {
  if (!move) return 'Ask about this position';
  const label = moveLabel(move.fenBefore, move.san);
  return short ? `Why ${label}?` : `Ask why about ${label}`;
}
