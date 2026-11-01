// A variation: moves the Player tries on a board that shows a position to learn from (a Review, a
// finished Lesson, a solved Puzzle, a finished Engine Game, the Board after stepping back), on a
// line of its own that never changes the game's. It branches from one position of the game, and
// Back to the game drops it. The browser's Engine grades each of its moves on screen, as it does in
// play (ADR 0007); a Why Question about one sends only the moves, and the desktop's Engine works
// out the Coach's facts.
import type { GradedMove } from '@chess-coach/shared/analysis';
import { outcomeOf, playUci, type PlayedMove } from '@chess-coach/shared/chess';
import type { MoveGrade } from '@chess-coach/shared/grader';
import { gradeMove } from './engine/engine.svelte.ts';
import { Line } from './game.svelte.ts';
import { gradeMark, type GradeMark } from './grades.ts';

/** Where a step button goes. */
export type Step = 'first' | 'previous' | 'next' | 'last';

/** Steps a line: the start, one move back or on, or its end. */
export function stepLine(line: Line, where: Step, first = 0): void {
  line.goTo({ first, previous: Math.max(first, line.cursor - 1), next: line.cursor + 1, last: line.moves.length }[where]);
}

/** What a Why Question about the position shown in a variation asks: its last move, or the position itself at its start. */
export interface VariationQuestion {
  fen: string;
  recentMoves: string[];
  moveUci?: string;
  /** What the Coach panel shows the Player asked, when they typed nothing. */
  label: string;
}

export class Variation {
  /** The game's cursor the variation branches from (its moves start in that position); null while the board shows the game. */
  from = $state<number | null>(null);
  readonly line = new Line();
  /** The browser Engine's Move Grade of each of the variation's moves: null where it can't have one (the Engine failed, or the game was over). */
  graded = $state<(GradedMove | null | undefined)[]>([]);
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

  /** The Move Grade of the move that reached the position shown: undefined while it is coming, null when none will. */
  get shownGrade(): GradedMove | null | undefined {
    return this.graded[this.line.cursor - 1];
  }

  /**
   * Where the game steps to when `uci` is the game's own next move from the position on the board,
   * as on Lichess: from the game's position `at`, or from the variation's first position, which is
   * the game's where it branched. Null when the move starts or carries on a variation instead.
   */
  gameStep(uci: string, game: readonly PlayedMove[], at: number): number | null {
    if (this.from !== null && this.line.cursor > 0) return null;
    const from = this.from ?? at;
    return game[from]?.uci === uci ? from + 1 : null;
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

  /** A Why Question about the position shown: the game's moves up to the branch, then the variation's, and the move that reached it. */
  question(game: readonly PlayedMove[]): VariationQuestion {
    const before = game.slice(0, this.from ?? 0).map((m) => m.san);
    const moves = this.line.moves.slice(0, this.line.cursor);
    const last = moves.at(-1);
    if (!last) return { fen: this.fen, recentMoves: before, label: 'What are the options in this position?' };
    const grade = this.grades[moves.length - 1];
    return {
      fen: last.fenBefore,
      recentMoves: [...before, ...moves.slice(0, -1).map((m) => m.san)],
      moveUci: last.uci,
      label: grade ? `Why is ${last.san} graded ${grade}?` : `Why ${last.san}?`,
    };
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
    const run = this.#runs;
    const settle = (g: GradedMove | null): void => {
      const now = this.line.moves[index];
      if (run !== this.#runs || now?.fenBefore !== m.fenBefore || now.uci !== m.uci) return;
      const next = [...this.graded];
      next[index] = g;
      this.graded = next;
    };
    // A move from a finished position has nothing to be graded against.
    if (outcomeOf(m.fenBefore)) {
      settle(null);
      return;
    }
    // A move the Engine can't grade stays ungraded; an Engine that can't start says so itself.
    gradeMove((this.from ?? 0) + index + 1, m.fenBefore, m.uci, m.fenAfter).then(settle, () => settle(null));
  }
}
