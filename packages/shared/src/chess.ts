// Move rules for every client and the backend, built on chessops.
import { Chess } from 'chessops/chess';
import { INITIAL_FEN, makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import type { Setup } from 'chessops/setup';
import { SquareSet } from 'chessops/squareSet';
import { makeSquare, makeUci, parseSquare, parseUci } from 'chessops/util';
import { COLORS, type Color, type Role, type Square } from 'chessops/types';

export { INITIAL_FEN };
export type { Color };

export type Side = 'white' | 'black';

/** Each side's name as the Player reads it. */
export const SIDE_NAMES: Record<Side, string> = { white: 'White', black: 'Black' };

export function otherSide(side: Side): Side {
  return side === 'white' ? 'black' : 'white';
}

/** The move number a scoresheet gives the move played from `fen`; a game may start mid-way. */
export function moveNumberOf(fen: string): number {
  const n = Number(fen.split(' ')[5]);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** A move as a scoresheet writes it: "11. Bxf7+" for White, "11… Rxf7" for Black. */
export function moveLabel(fenBefore: string, san: string): string {
  return `${moveNumberOf(fenBefore)}${turnOf(fenBefore) === 'white' ? '.' : '…'} ${san}`;
}

export interface PlayedMove {
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
}

export function positionFromFen(fen: string): Chess {
  return Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
}

export function isValidFen(fen: string): boolean {
  const setup = parseFen(fen);
  if (setup.isErr) return false;
  return Chess.fromSetup(setup.value).isOk;
}

/**
 * A pasted position as standard chess can have it, or undefined for one no game can reach. chessops
 * checks the kings, the back-rank pawns and the side not to move being in check; this adds the
 * material, at most 8 pawns a side and only the extra pieces their promotions can give, and keeps a
 * castling right only for a king on e1 or e8 and a rook in its corner, where chessops would allow
 * Chess960 castling.
 */
export function standardPosition(setup: Setup): Chess | undefined {
  for (const color of COLORS) {
    const count = (role: Role): number => setup.board.pieces(color, role).size();
    const promoted = Math.max(0, count('queen') - 1) + Math.max(0, count('rook') - 2) + Math.max(0, count('bishop') - 2) + Math.max(0, count('knight') - 2);
    if (setup.board[color].size() > 16 || count('pawn') + promoted > 8) return undefined;
  }
  let castlingRights = setup.castlingRights.intersect(SquareSet.corners());
  for (const color of COLORS) {
    if (setup.board.kingOf(color) !== parseSquare(color === 'white' ? 'e1' : 'e8')) castlingRights = castlingRights.diff(SquareSet.backrank(color));
  }
  const pos = Chess.fromSetup({ ...setup, castlingRights });
  return pos.isOk ? pos.value : undefined;
}

export function turnOf(fen: string): Side {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/** Plays a UCI move. Returns undefined when the move is malformed or illegal. */
export function playUci(fen: string, uci: string): PlayedMove | undefined {
  const pos = positionFromFen(fen);
  const move = parseUci(normaliseCastlingUci(pos, uci));
  if (!move || !pos.isLegal(move)) return undefined;
  const san = makeSan(pos, move);
  const uciOut = kingMoveUci(pos, makeUci(move));
  pos.play(move);
  return { uci: uciOut, san, fenBefore: fen, fenAfter: makeFen(pos.toSetup()) };
}

/** Plays a SAN move. Returns undefined when the move is malformed or illegal. */
export function playSan(fen: string, san: string): PlayedMove | undefined {
  const pos = positionFromFen(fen);
  const move = parseSan(pos, san);
  if (!move) return undefined;
  return playUci(fen, makeUci(move));
}

// Moves in SAN as people write them: castling (with O's or zeros), piece moves, pawn captures and pawn pushes.
const SAN_IN_TEXT = /(?<![\w-])(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][1-8](?:=?[QRBN])?)(?=[+#!?]*(?![\w-]))/g;
// The words that make a bare square a move: "Why not d4?", "Why d4?", "play d4", "What about d4?", or nothing at all.
const PUSH_CUE = /(?:^|\b(?:not|why|play|played|playing|push|pushed|pushing|about))\s*$/i;

/**
 * The moves `text` names in SAN, in order, castling written with O's. A pawn push such as "e5"
 * reads like a square ("my knight on e5"), so it counts only with `pushes`, and only when the
 * words just before it make it a move.
 */
export function sansIn(text: string, { pushes = false } = {}): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SAN_IN_TEXT)) {
    const san = (m[1] as string).replaceAll('0', 'O');
    if (/^[a-h][1-8]/.test(san) && !(pushes && PUSH_CUE.test(text.slice(0, m.index)))) continue;
    out.push(san);
  }
  return out;
}

export function isLegalUci(fen: string, uci: string): boolean {
  return playUci(fen, uci) !== undefined;
}

export function uciToSan(fen: string, uci: string): string | undefined {
  return playUci(fen, uci)?.san;
}

/** Plays a sequence of UCI moves, stopping at the first illegal one. */
export function playLine(fen: string, ucis: readonly string[]): PlayedMove[] {
  const out: PlayedMove[] = [];
  let current = fen;
  for (const uci of ucis) {
    const played = playUci(current, uci);
    if (!played) break;
    out.push(played);
    current = played.fenAfter;
  }
  return out;
}

export function sanLine(fen: string, ucis: readonly string[]): string[] {
  return playLine(fen, ucis).map((m) => m.san);
}

/** Every legal move from a position, as UCI. */
export function legalMoves(fen: string): string[] {
  const pos = positionFromFen(fen);
  const out: string[] = [];
  for (const [from, targets] of pos.allDests()) {
    for (const to of targets) {
      const piece = pos.board.get(from);
      const promotes = piece?.role === 'pawn' && (squareRank(to) === 0 || squareRank(to) === 7);
      if (promotes) {
        for (const role of ['q', 'r', 'b', 'n']) out.push(`${makeSquare(from)}${makeSquare(to)}${role}`);
      } else {
        out.push(kingMoveUci(pos, `${makeSquare(from)}${makeSquare(to)}`));
      }
    }
  }
  return out;
}

/** Legal destination squares by origin square, for the board UI. */
export function legalDests(fen: string): Map<string, string[]> {
  const pos = positionFromFen(fen);
  const out = new Map<string, string[]>();
  for (const [from, targets] of pos.allDests()) {
    const list: string[] = [];
    for (const to of targets) list.push(kingMoveUci(pos, `${makeSquare(from)}${makeSquare(to)}`).slice(2, 4));
    if (list.length) out.set(makeSquare(from), list);
  }
  return out;
}

export interface BoardPiece {
  square: string;
  color: Side;
  role: Role;
}

export function piecesOf(fen: string): BoardPiece[] {
  const pos = positionFromFen(fen);
  const out: BoardPiece[] = [];
  for (const [sq, piece] of pos.board) {
    out.push({ square: makeSquare(sq), color: piece.color, role: piece.role });
  }
  return out;
}

export function isPromotion(fen: string, from: string, to: string): boolean {
  const pos = positionFromFen(fen);
  const sq = parseSquare(from);
  const target = parseSquare(to);
  if (sq === undefined || target === undefined) return false;
  const piece = pos.board.get(sq);
  return piece?.role === 'pawn' && (squareRank(target) === 0 || squareRank(target) === 7);
}

export type Outcome = { winner: Side | undefined; reason: 'checkmate' | 'stalemate' | 'insufficient' | 'draw' | 'repetition' } | undefined;

/** How a position ends the game on its own; a repetition needs the moves, see outcomeOfLine. */
export function outcomeOf(fen: string): Outcome {
  const pos = positionFromFen(fen);
  if (pos.isCheckmate()) return { winner: otherSide(pos.turn), reason: 'checkmate' };
  if (pos.isStalemate()) return { winner: undefined, reason: 'stalemate' };
  if (pos.isInsufficientMaterial()) return { winner: undefined, reason: 'insufficient' };
  if (pos.halfmoves >= 100) return { winner: undefined, reason: 'draw' };
  return undefined;
}

/** How a game played from `startFen` ends: the final position's outcome, or a draw once that position has occurred three times. */
export function outcomeOfLine(startFen: string, moves: readonly { fenAfter: string }[]): Outcome {
  // The start as the positions after it are written: an en passant square no pawn can use, or a
  // castling right with no rook, is left out, so the same position always has the same key.
  const fens = [makeFen(positionFromFen(startFen).toSetup()), ...moves.map((m) => m.fenAfter)];
  const last = fens.at(-1) as string;
  const outcome = outcomeOf(last);
  if (outcome) return outcome;
  const key = positionKey(last);
  return fens.filter((fen) => positionKey(fen) === key).length >= 3 ? { winner: undefined, reason: 'repetition' } : undefined;
}

export function isCheck(fen: string): boolean {
  return positionFromFen(fen).isCheck();
}

/** FEN without the move counters, used as a key for positions reached by any move order. */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function squareRank(sq: Square): number {
  return sq >> 3;
}

/** chessops wants king-takes-rook castling; accept the e1g1 form engines and people use. */
function normaliseCastlingUci(pos: Chess, uci: string): string {
  const castles: Record<string, string> = { e1g1: 'e1h1', e1c1: 'e1a1', e8g8: 'e8h8', e8c8: 'e8a8' };
  const alt = castles[uci];
  if (!alt) return uci;
  const from = parseSquare(uci.slice(0, 2));
  if (from === undefined) return uci;
  const piece = pos.board.get(from);
  return piece?.role === 'king' ? alt : uci;
}

/** chessops writes castling as king-takes-rook; engines and the protocol use e1g1. */
function kingMoveUci(pos: Chess, uci: string): string {
  const map: Record<string, string> = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };
  const alt = map[uci];
  if (!alt) return uci;
  const from = parseSquare(uci.slice(0, 2));
  return from !== undefined && pos.board.get(from)?.role === 'king' ? alt : uci;
}
