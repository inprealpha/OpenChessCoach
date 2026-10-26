// A line of moves the Player can step through, shared by every board screen.
import { INITIAL_FEN, playUci, type PlayedMove } from '@chess-coach/shared/chess';

export class Line {
  startFen = $state(INITIAL_FEN);
  moves = $state<PlayedMove[]>([]);
  /** Number of moves applied to the shown position: 0 is the start. */
  cursor = $state(0);

  constructor(startFen: string = INITIAL_FEN, ucis: readonly string[] = []) {
    this.reset(startFen, ucis);
  }

  reset(startFen: string = INITIAL_FEN, ucis: readonly string[] = []): void {
    this.startFen = startFen;
    const moves: PlayedMove[] = [];
    let fen = startFen;
    for (const uci of ucis) {
      const m = playUci(fen, uci);
      if (!m) break;
      moves.push(m);
      fen = m.fenAfter;
    }
    this.moves = moves;
    this.cursor = moves.length;
  }

  get fen(): string {
    return this.cursor === 0 ? this.startFen : (this.moves[this.cursor - 1] as PlayedMove).fenAfter;
  }

  get lastMove(): PlayedMove | undefined {
    return this.moves[this.cursor - 1];
  }

  get atEnd(): boolean {
    return this.cursor === this.moves.length;
  }

  /** Plays a move from the shown position, dropping any moves after it. */
  play(uci: string): PlayedMove | undefined {
    const m = playUci(this.fen, uci);
    if (!m) return undefined;
    this.moves = [...this.moves.slice(0, this.cursor), m];
    this.cursor = this.moves.length;
    return m;
  }

  /** Removes the last move. */
  takeBack(count = 1): void {
    this.moves = this.moves.slice(0, Math.max(0, this.moves.length - count));
    this.cursor = this.moves.length;
  }

  back(): void {
    if (this.cursor > 0) this.cursor--;
  }

  forward(): void {
    if (this.cursor < this.moves.length) this.cursor++;
  }

  goTo(cursor: number): void {
    this.cursor = Math.max(0, Math.min(this.moves.length, cursor));
  }

  sansUntilCursor(): string[] {
    return this.moves.slice(0, this.cursor).map((m) => m.san);
  }
}
