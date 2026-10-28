// The fake tempting moves, for verify mode and tests (ADR 0006): a fixed rule, so a position always
// gets the same moves, and no model or network. Captures first, the biggest piece taken first,
// then checks, then the remaining moves in the move generator's order.
import { isCheck, legalMoves, piecesOf, playUci } from '@chess-coach/shared/chess';
import { gamePositions } from './maia.ts';
import type { TemptingMovesPort, TemptingMovesRequest } from './port.ts';

const VALUE: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

export class FakeTemptingMoves implements TemptingMovesPort {
  readonly name = 'fake' as const;
  /** Every request, for tests to inspect. */
  readonly requests: TemptingMovesRequest[] = [];

  async suggest(req: TemptingMovesRequest): Promise<string[]> {
    this.requests.push(req);
    const fen = gamePositions(req.startFen, req.moves).at(-1)!;
    const pieces = new Map(piecesOf(fen).map((p) => [p.square, p]));
    return legalMoves(fen)
      .map((uci, order) => {
        const taken = pieces.get(uci.slice(2, 4));
        const score = taken ? 100 + VALUE[taken.role]! : isCheck(playUci(fen, uci)!.fenAfter) ? 50 : 0;
        return { uci, score, order };
      })
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, req.count ?? 3)
      .map((m) => m.uci);
  }
}
