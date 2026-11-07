// Looking back during an Engine Game: the step buttons, the arrow keys and the move list show an
// earlier position of the game, while the game itself stays at its latest position, where its next
// move is played. If the Engine moves meanwhile, the board stays where the Player is looking.
import { turnOf, type PlayedMove } from '@chess-coach/shared/chess';
import type { Line } from './game.svelte.ts';
import type { Step } from './variation.svelte.ts';

export class LookBack {
  /** The position the board shows, as a count of the game's moves; null at the game's latest position. */
  at = $state<number | null>(null);
  /** How many moves the game had when the Player stepped back, so the bar can say the Engine has moved since. */
  #since = $state(0);
  readonly #game: Line;

  constructor(game: Line) {
    this.#game = game;
  }

  /** Whether the board shows an earlier position than the game's latest. */
  get active(): boolean {
    return this.at !== null;
  }

  /** The count of the game's moves up to the position shown, the latest included. */
  get cursor(): number {
    return Math.min(this.at ?? this.#game.moves.length, this.#game.moves.length);
  }

  get fen(): string {
    const c = this.cursor;
    return c === 0 ? this.#game.startFen : (this.#game.moves[c - 1] as PlayedMove).fenAfter;
  }

  /** The move that reached the position shown. */
  get lastMove(): PlayedMove | undefined {
    return this.#game.moves[this.cursor - 1];
  }

  /** The move shown, in the move list's words: "move 8". */
  get where(): string {
    return `move ${moveNumber(this.cursor)}`;
  }

  /** The game's latest move, in words ("12… d5"), when it was played after the Player stepped back. */
  get playedSince(): string | null {
    const latest = this.#game.moves.at(-1);
    if (this.at === null || !latest || this.#game.moves.length <= this.#since) return null;
    return `${moveNumber(this.#game.moves.length)}${turnOf(latest.fenBefore) === 'black' ? '…' : '.'} ${latest.san}`;
  }

  /** Shows the position after `cursor` of the game's moves; the latest position ends the look back. */
  goTo(cursor: number): void {
    const end = this.#game.moves.length;
    const to = Math.max(0, Math.min(end, cursor));
    if (this.at === null && to !== end) this.#since = end;
    this.at = to === end ? null : to;
  }

  step(where: Step): void {
    const at = this.cursor;
    this.goTo({ first: 0, previous: at - 1, next: at + 1, last: this.#game.moves.length }[where]);
  }

  /** Back to the game: the board shows its latest position again. */
  leave(): void {
    this.at = null;
  }
}

/** The move number a count of moves ends on, as the move list numbers them: 15 moves end on move 8. */
export function moveNumber(plies: number): number {
  return Math.max(1, Math.ceil(plies / 2));
}
