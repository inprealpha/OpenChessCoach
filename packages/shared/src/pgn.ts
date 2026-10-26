// PGN parsing for imports. Every move is replayed with the move rules, so a game that
// parses is a game every screen can show.
import { makeFen } from 'chessops/fen';
import { parsePgn as parseGames, startingPosition, type PgnNodeData, type Game } from 'chessops/pgn';
import { INITIAL_FEN, moveNumberOf, outcomeOf, playSan, standardPosition, turnOf, type Side } from './chess.ts';

export interface ParsedGame {
  headers: Record<string, string>;
  startFen: string;
  /** Mainline moves in UCI. */
  moves: string[];
  sans: string[];
  result: string;
  /** False for a game whose result is still "*". */
  finished: boolean;
}

export class PgnImportError extends Error {}

export function parsePgnGames(text: string): ParsedGame[] {
  const games = parseGames(text);
  return games.map(toParsed).filter((g): g is ParsedGame => g !== undefined);
}

/** Parses exactly one game, with errors written for the Player. */
export function parseSinglePgn(pasted: string): ParsedGame {
  if (!pasted.trim()) throw new PgnImportError('Paste a PGN first.');
  const text = asStandardPgn(pasted);
  const games = parseGames(text);
  if (games.length === 0) throw new PgnImportError('That doesn’t look like a PGN. A PGN lists moves like "1. e4 e5 2. Nf3".');
  if (games.length > 1) throw new PgnImportError('That PGN holds more than one game. Paste one game at a time.');
  const game = games[0] as Game<PgnNodeData>;
  if (!game.moves.children.length) throw new PgnImportError('That PGN has no moves.');
  const stray = firstNonMove(text);
  if (stray) throw new PgnImportError(`Move ${stray} is not a legal move.`);
  return toParsedStrict(game);
}

// A move the novelty mark "N" can follow without making it a different move: a piece move, castling,
// or a pawn move that doesn't promote ("e8N" is a promotion), with its check sign and annotation.
const NOVELTY = /(?<=(?:^|[\s.…(])(?:[NBRQK][a-h]?[1-8]?x?[a-h][1-8]|[O0]-[O0](?:-[O0])?|[a-h](?:x[a-h])?[2-7])[+#]?[!?]{0,2})(?:N|\s+N(?!\s+x?[a-h][1-8]))(?=[\s)]|$)/g;

/**
 * Rewrites what other sites and books print differently from PGN: "½-½" for a draw, and the novelty
 * mark "N" after a move ("4.Ba4N", "3.Bb5!N", "4. Ba4 N"). An "N" before a square ("2. N f3") is left
 * for the move check, as it may be a knight's move written with a space.
 */
function asStandardPgn(text: string): string {
  return text.replace(/½[-–—]½/g, '1/2-1/2').replace(NOVELTY, '');
}

// The PGN movetext tokens chessops reads (its own tokenizer's pattern), anchored so a token must be
// read whole. chessops skips any text that doesn't match, which turns "2. Ke9" into no move at all.
const PGN_TOKEN =
  /(?:[NBKRQ]?[a-h]?[1-8]?[-x]?[a-h][1-8](?:=?[nbrqkNBRQK])?|[pnbrqkPNBRQK]?@[a-h][1-8]|[O0o][-–—][O0o](?:[-–—][O0o])?)[+#]?|--|Z0|0000|@@@@|\$\d{1,4}|[?!]{1,2}|\*|1[-–—]0|0[-–—]1|1\/2[-–—]1\/2/y;
const SAN = /^(?:[NBKRQ]?[a-h]?[1-8]?[-x]?[a-h][1-8]|[pnbrqkPNBRQK]?@|[O0o][-–—]|--|Z0|0000|@@@@)/;

/**
 * Finds the first word in a PGN's moves that isn't a move, a move number, an annotation or a
 * result, labelled like "2. Ke9". Comments, headers and annotation symbols such as "+-" are fine.
 */
function firstNonMove(text: string): string | undefined {
  const moves = text
    .replace(/\{[^}]*(?:\}|$)/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('%') && !/^\s*\[\w+\s+".*"\s*\]\s*$/.test(line))
    .map((line) => line.replace(/;.*$/, ''))
    .join(' ')
    .replace(/[()]/g, ' ');
  let moveNo = 1;
  let white = true;
  for (const word of moves.split(/\s+/)) {
    // Some sites write Black's move number with a "…", and an en passant capture as "exf6e.p.".
    let rest = word.replace(/…/g, '...').replace(/(?<=[a-h][36])e\.p\.$/, '');
    const number = /^(\d+)(\.+)/.exec(rest);
    if (number) {
      moveNo = Number(number[1]);
      white = (number[2] as string).length < 3;
      rest = rest.slice(number[0].length);
    }
    if (!rest || /^[^\p{L}\p{N}]+$/u.test(rest) || rest === 'e.p.') continue;
    let read = 0;
    let isMove = false;
    while (read < rest.length) {
      PGN_TOKEN.lastIndex = read;
      const m = PGN_TOKEN.exec(rest);
      if (!m) return `${moveNo}${white ? '.' : '...'} ${rest}`;
      if (SAN.test(m[0])) isMove = true;
      read = PGN_TOKEN.lastIndex;
    }
    if (isMove) {
      if (!white) moveNo++;
      white = !white;
    }
  }
  return undefined;
}

function toParsed(game: Game<PgnNodeData>): ParsedGame | undefined {
  try {
    return toParsedStrict(game);
  } catch {
    return undefined;
  }
}

const ENDED_BY_THE_BOARD: readonly string[] = ['checkmate', 'stalemate', 'insufficient'];

function toParsedStrict(game: Game<PgnNodeData>): ParsedGame {
  const headers: Record<string, string> = {};
  for (const [k, v] of game.headers) headers[k] = v;
  const start = startingPosition(game.headers);
  const standard = start.isOk ? standardPosition(start.value.toSetup()) : undefined;
  if (!standard) throw new PgnImportError('The PGN’s starting position (FEN header) is not valid.');
  if ((headers.Variant ?? 'Standard').toLowerCase() !== 'standard' && headers.Variant !== 'From Position') {
    throw new PgnImportError(`Only standard chess can be imported, not ${headers.Variant}.`);
  }
  const startFen = headers.FEN ? makeFen(standard.toSetup()) : INITIAL_FEN;
  const moves: string[] = [];
  const sans: string[] = [];
  let fen = startFen;
  for (const node of game.moves.mainline()) {
    const played = playSan(fen, node.san);
    if (!played) {
      // Numbered from the position it was played in, so a game from a [FEN] counts from there.
      throw new PgnImportError(`Move ${moveNumberOf(fen)}${turnOf(fen) === 'white' ? '.' : '...'} ${node.san} is not legal in that position.`);
    }
    moves.push(played.uci);
    sans.push(played.san);
    fen = played.fenAfter;
  }
  const given = headers.Result ?? '*';
  // Moves copied from a book or a chat often come without a result: when they end the game, the
  // board decides it. A draw by the fifty-move rule or by repetition has to be claimed, so only
  // checkmate, stalemate and too little material to mate decide it.
  const end = given === '*' ? outcomeOf(fen) : undefined;
  const decided = end && ENDED_BY_THE_BOARD.includes(end.reason) ? end : undefined;
  const result = decided ? (decided.winner === 'white' ? '1-0' : decided.winner === 'black' ? '0-1' : '1/2-1/2') : given;
  return { headers, startFen, moves, sans, result, finished: result !== '*' };
}

/** A stable hash of a game's moves, used to recognise a pasted game imported twice. */
export function movesHash(startFen: string, moves: readonly string[]): string {
  const text = `${startFen}|${moves.join(' ')}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Which side a username played, if the headers say. */
export function sideOf(headers: Record<string, string>, username: string | undefined): Side | undefined {
  if (!username) return undefined;
  const u = username.toLowerCase();
  if (headers.White?.toLowerCase() === u) return 'white';
  if (headers.Black?.toLowerCase() === u) return 'black';
  return undefined;
}

/** Writes a minimal PGN for a game played in the app. */
export function makeSimplePgn(headers: Record<string, string>, sans: readonly string[], result: string): string {
  const head = Object.entries(headers)
    .map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`)
    .join('\n');
  const body: string[] = [];
  sans.forEach((san, i) => {
    if (i % 2 === 0) body.push(`${i / 2 + 1}.`);
    body.push(san);
  });
  body.push(result);
  return `${head}\n\n${body.join(' ')}\n`;
}
