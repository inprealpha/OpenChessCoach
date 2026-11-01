// A variation: moves the Player tries on a board that shows a position to learn from (a Review, a
// finished Lesson, a solved Puzzle, a finished Engine Game), on a line of its own that never
// changes the game's. It branches from one position of the game, and Back to the game drops it.
// The browser's Engine grades each of its moves on screen, as it does in play (ADR 0007); a Why
// Question about one sends only the moves, and the desktop's Engine works out the Coach's facts.
import type { GradedMove } from '@chess-coach/shared/analysis';
import { outcomeOf, playUci, type PlayedMove } from '@chess-coach/shared/chess';
import type { MoveGrade } from '@chess-coach/shared/grader';
import { gradeMove } from './engine/engine.svelte.ts';
import { Line } from './game.svelte.ts';
import { gradeMark, type GradeMark } from './grades.ts';

export class Variation {
  /** The game's cursor the variation branches from (its moves start in that position); null while the board shows the game. */
  from = $state<number | null>(null);
  readonly line = new Line();
  /** The browser Engine's Move Grade of each of the variation's moves, once it has one. */
  graded = $state<(GradedMove | undefined)[]>([]);
  /** Counts the variations started and dropped, so a Move Grade for one already gone is dropped too. */
  #runs = 0;

  get active(): boolean {
    return this.from !== null;
  }

  /** The position the variation shows. */
  get fen(): string {
    return this.line.fen;
  }

  get grades(): (MoveGrade | undefined)[] {
    return this.graded.map((g) => g?.grade);
  }

  /** The Move Grade of the variation's move that reached the position shown, on the square it landed on. */
  get mark(): GradeMark | undefined {
    return gradeMark(this.line.lastMove, this.grades[this.line.cursor - 1]);
  }

  /** The SAN of the game's moves up to the branch, then the variation's up to the position shown: the Coach's recent moves. */
  movesSoFar(game: readonly PlayedMove[]): string[] {
    return [...game.slice(0, this.from ?? 0), ...this.line.moves.slice(0, this.line.cursor)].map((m) => m.san);
  }

  /**
   * Plays a move on the board. Away from a variation it starts one in the game's position `at`;
   * in one, it plays from the position shown, stepping forward where the variation already has
   * that move, as on Lichess, and otherwise replacing the variation's later moves (never the game's).
   */
  play(uci: string, at: { cursor: number; fen: string }): PlayedMove | undefined {
    if (this.from === null) {
      if (!playUci(at.fen, uci)) return undefined;
      this.#runs++;
      this.from = at.cursor;
      this.line.reset(at.fen);
      this.graded = [];
    } else if (this.line.moves[this.line.cursor]?.uci === uci) {
      this.line.forward();
      return this.line.lastMove;
    }
    const index = this.line.cursor;
    const m = this.line.play(uci);
    if (!m) return undefined;
    this.graded = this.graded.slice(0, index);
    this.#grade(index, m);
    return m;
  }

  /** Back to the game: drops the variation, so the board shows the game where the Player left it. */
  leave(): void {
    if (this.from === null) return;
    this.#runs++;
    this.from = null;
    this.line.reset();
    this.graded = [];
  }

  #grade(index: number, m: PlayedMove): void {
    // A move from a finished position has nothing to be graded against.
    if (outcomeOf(m.fenBefore)) return;
    const run = this.#runs;
    gradeMove((this.from ?? 0) + index + 1, m.fenBefore, m.uci, m.fenAfter).then(
      (g) => {
        const now = this.line.moves[index];
        if (run !== this.#runs || now?.fenBefore !== m.fenBefore || now.uci !== m.uci) return;
        const next = [...this.graded];
        next[index] = g;
        this.graded = next;
      },
      // The move stays ungraded; an Engine that can't start says so itself.
      () => undefined,
    );
  }
}
