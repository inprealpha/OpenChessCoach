// Names a game's opening from Lichess's chess-openings data, by position so transpositions count.
import { INITIAL_FEN, playLine, positionKey } from './chess.ts';

export interface OpeningEntry {
  eco: string;
  name: string;
  /** Moves in UCI, space-separated. */
  uci: string;
}

export class OpeningBook {
  private readonly byPosition = new Map<string, OpeningEntry>();

  constructor(entries: readonly OpeningEntry[]) {
    for (const e of entries) {
      const line = playLine(INITIAL_FEN, e.uci.split(' '));
      const last = line[line.length - 1];
      if (!last) continue;
      const key = positionKey(last.fenAfter);
      const existing = this.byPosition.get(key);
      if (!existing || e.uci.length < existing.uci.length) this.byPosition.set(key, e);
    }
  }

  /** The deepest named position the game reaches, if any. */
  name(moves: readonly string[], startFen: string = INITIAL_FEN): OpeningEntry | undefined {
    if (startFen !== INITIAL_FEN) return undefined;
    let found: OpeningEntry | undefined;
    for (const m of playLine(startFen, moves.slice(0, 40))) {
      const hit = this.byPosition.get(positionKey(m.fenAfter));
      if (hit) found = hit;
    }
    return found;
  }
}
