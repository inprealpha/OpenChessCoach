// Maia-3 (CSSLab, University of Toronto; weights AGPL-3.0, see THIRD_PARTY_NOTICES.md): a network
// trained only to predict the move a human of a given rating plays. Its 5M model, converted to ONNX
// by data-prep/maia3-onnx-export.py, runs here on onnxruntime's WebAssembly build (ADR 0011). The
// input encoding is written from Maia-3's own (maia3/dataset.py); data-prep/maia3-node.ts and the
// parity test check it gives the same moves as the original.
import { legalMoves, piecesOf, playUci, turnOf } from '@chess-coach/shared/chess';
import { loadOrt, type OrtModule } from './ort.ts';
import { DEFAULT_RATING, type TemptingMovesPort, type TemptingMovesRequest } from './port.ts';

/** Maia-3 reads the last 8 positions of the game. */
export const MAIA_HISTORY = 8;
/** Per square: 12 piece planes for each of the 8 positions, then a think-time column the model ignores. */
export const MAIA_WIDTH = 12 * MAIA_HISTORY + 1;

const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const squareIndex = (name: string) => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

/** Every position of the game, from its first to the one asked about. */
export function gamePositions(startFen: string, moves: readonly string[]): string[] {
  const fens = [startFen];
  for (const uci of moves) {
    const next = playUci(fens.at(-1)!, uci);
    if (!next) throw new Error(`The move ${uci} is not legal in ${fens.at(-1)}.`);
    fens.push(next.fenAfter);
  }
  return fens;
}

/**
 * Maia-3's input for the last position in `fens`: for each square (a1 = 0), 12 piece planes for
 * each of the last 8 positions, oldest first, the earliest repeated when there are fewer. Each
 * position is seen from its own side to move, as python-chess's mirror() does when Black is to
 * move: planes 0–5 are that side's pawn to king, 6–11 the other side's.
 */
export function maiaInput(fens: readonly string[]): Float32Array {
  const last = fens.slice(-MAIA_HISTORY);
  const padded = [...Array<string>(MAIA_HISTORY - last.length).fill(last[0]!), ...last];
  const out = new Float32Array(64 * MAIA_WIDTH);
  padded.forEach((fen, h) => {
    const turn = turnOf(fen);
    for (const piece of piecesOf(fen)) {
      const sq = turn === 'black' ? squareIndex(piece.square) ^ 56 : squareIndex(piece.square);
      out[sq * MAIA_WIDTH + h * 12 + ROLES.indexOf(piece.role) + (piece.color === turn ? 0 : 6)] = 1;
    }
  });
  return out;
}

/**
 * A move's index in Maia-3's 4,352 scores, from the side to move's point of view (ranks mirrored
 * when Black is to move): from × 64 + to for the 4,096 plain moves, then 256 promotions by from
 * file, to file and piece (q, r, b, n).
 */
export function maiaMoveIndex(uci: string, black: boolean): number {
  const m = black ? uci.replace(/[1-8]/g, (r) => String(9 - Number(r))) : uci;
  if (m.length === 5) return 4096 + (m.charCodeAt(0) - 97) * 32 + (m.charCodeAt(2) - 97) * 4 + 'qrbn'.indexOf(m[4]!);
  return squareIndex(m.slice(0, 2)) * 64 + squareIndex(m.slice(2, 4));
}

/** Maia-3 on this desktop, loaded from the downloaded model file's bytes. */
export class MaiaTemptingMoves implements TemptingMovesPort {
  readonly name = 'maia' as const;
  private readonly ort: OrtModule;
  private readonly session: Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;
  // onnxruntime-web runs one inference at a time per session.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(ort: OrtModule, session: MaiaTemptingMoves['session']) {
    this.ort = ort;
    this.session = session;
  }

  static async load(model: Uint8Array, threads: number): Promise<MaiaTemptingMoves> {
    const ort = await loadOrt(threads);
    return new MaiaTemptingMoves(ort, await ort.InferenceSession.create(model));
  }

  suggest(req: TemptingMovesRequest): Promise<string[]> {
    const run = this.queue.then(() => this.run(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(req: TemptingMovesRequest): Promise<string[]> {
    req.signal?.throwIfAborted();
    const fens = gamePositions(req.startFen, req.moves);
    const fen = fens.at(-1)!;
    const { Tensor } = this.ort;
    const out = await this.session.run({
      tokens: new Tensor('float32', maiaInput(fens), [1, 64, MAIA_WIDTH]),
      self_elos: new Tensor('int64', BigInt64Array.of(BigInt(Math.round(req.rating ?? DEFAULT_RATING))), [1]),
      oppo_elos: new Tensor('int64', BigInt64Array.of(BigInt(Math.round(req.opponentRating ?? req.rating ?? DEFAULT_RATING))), [1]),
    });
    const scores = out.logits_move!.data as Float32Array;
    const black = turnOf(fen) === 'black';
    return legalMoves(fen)
      .map((uci) => ({ uci, score: scores[maiaMoveIndex(uci, black)]! }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.count ?? 3)
      .map((m) => m.uci);
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}
