// What the Ask box says before the Player types: the move a Why Question would ask about, as a
// scoresheet writes it ("Ask why about 11. Bxf7+"), so the Player knows what the Coach will explain.
import { moveLabel } from '@chess-coach/shared/chess';

/** The Ask box's placeholder for a question about `move`, or about the position when there is none. */
export function askAbout(move: { fenBefore: string; san: string } | undefined): string {
  return move ? `Ask why about ${moveLabel(move.fenBefore, move.san)}` : 'Ask about this position';
}
