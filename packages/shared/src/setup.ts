// What a Player pastes to set up the Board: a FEN for one position, or one game's PGN to step
// through. Read with the move rules, so a position that loads is one every board can show.
import { makeFen, parseFen } from 'chessops/fen';
import { parsePgn } from 'chessops/pgn';
import { standardPosition } from './chess.ts';
import { parseSinglePgn, PgnImportError } from './pgn.ts';

export interface SetUpPosition {
  startFen: string;
  /** The PGN's mainline in UCI; empty for a FEN. */
  moves: string[];
}

const FEN_EXAMPLE = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const NO_MOVES = 'That PGN has no moves.';

/** Reads a pasted FEN or PGN, with errors written for the Player. */
export function readPosition(text: string): SetUpPosition {
  const trimmed = text.trim();
  if (!trimmed) throw new PgnImportError('Paste a FEN or a PGN first.');
  const first = trimmed.split(/\s/)[0] as string;
  // A game's address, such as lichess.org/q7ZvsdUF: the app opens nothing, so the Player pastes what the page gives.
  if (/^[a-z]+:\/\//i.test(first) || /^[\w-]+(\.[\w-]+)+\//.test(first)) {
    throw new PgnImportError('That’s a link, not a FEN or a PGN. Paste the game’s PGN or a FEN instead.');
  }
  // A FEN's first word is the board, ranks split by "/"; a PGN opens with a header or a move number.
  if (first.includes('/') && !/\d+\./.test(trimmed)) return readFen(trimmed);
  try {
    const game = parseSinglePgn(trimmed);
    return { startFen: game.startFen, moves: game.moves };
  } catch (e) {
    if (!(e instanceof PgnImportError)) throw e;
    // Lichess exports a lone position as a PGN with its [FEN] and no moves.
    const fen = e.message === NO_MOVES ? parsePgn(trimmed)[0]?.headers.get('FEN') : undefined;
    if (fen) return readFen(fen);
    // Words with no header and no move read as an empty game: neither a FEN nor a PGN.
    const empty = e.message === NO_MOVES && !trimmed.startsWith('[');
    if (empty || e.message.startsWith('That doesn’t look like a PGN')) {
      throw new PgnImportError(`That isn’t a FEN or a PGN. A FEN describes one position, like ${FEN_EXAMPLE}; a PGN lists moves, like "1. e4 e5 2. Nf3".`);
    }
    throw e;
  }
}

function readFen(fen: string): SetUpPosition {
  const fields = fen.split(/[\s_]+/);
  // chessops would read a lone board as White to move with no castling: say so rather than guess.
  if (fields.length < 3) {
    throw new PgnImportError(`That FEN is missing who is to move or who may castle. Add them after the board, as in “${fields[0]} w KQkq - 0 1”: b for Black to move, and - if nobody may castle.`);
  }
  const setup = parseFen(fen);
  const pos = setup.isOk ? standardPosition(setup.value) : undefined;
  if (!pos) throw new PgnImportError(`That FEN isn’t a legal position. A FEN looks like ${FEN_EXAMPLE}.`);
  // The library's own form, so every later position of the line compares with it.
  return { startFen: makeFen(pos.toSetup()), moves: [] };
}
