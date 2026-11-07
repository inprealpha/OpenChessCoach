// The Coach move guard (ADR 0002): before a Coach reply reaches any client, every move and
// arrow is checked against the Engine's candidates in that call's brief, and the answers the
// desktop's Engine gave the Coach's questions in that call (ADR 0010), or, for a Review's overview,
// against the graded moves of the game its brief lists. Anything else is stripped. A Hint names no
// move at all, in its words either (`namedMove`).
import { legalMoves, playSan, playUci, positionKey } from '../chess.ts';
import { threatFen, type Brief } from './brief.ts';
import type { EngineMove } from './engine-tool.ts';
import type { Arrow, CoachRawReply } from './types.ts';

const SQUARE = /^[a-h][1-8]$/;
const MAX_ARROWS = 4;
const MAX_HIGHLIGHTS = 4;
const MAX_NOTE = 140;

export interface GuardResult {
  /** The reply's words: a Hint's that name a move become `HINT_FALLBACK`. */
  text: string;
  moves: string[];
  arrows: Arrow[];
  highlights: string[];
  note: string | null;
  /** Human-readable reasons for everything removed. */
  stripped: string[];
}

/**
 * The moves a Review overview's brief lists: the key moments, the Engine's better move at each and
 * the standout moves. The desktop took each from the game its Engine graded, legal where it was
 * played or would have been.
 */
export function gameMoves(brief: Brief): Set<string> {
  const out = new Set<string>();
  for (const m of [...(brief.game?.moments ?? []), ...(brief.game?.standouts ?? [])]) {
    out.add(m.uci);
    if (m.betterUci) out.add(m.betterUci);
  }
  return out;
}

/** The moves the Engine produced for this brief, each legal in the position it belongs to. */
export function allowedMoves(brief: Brief): Set<string> {
  const allowed = new Set<string>();
  // A Review's overview names moves from all over the game, not from one position.
  if (brief.game) return gameMoves(brief);
  // The tempting moves are Engine output too: the Engine graded each one in `fen` (ADR 0011).
  for (const c of [...brief.candidates, ...(brief.tempting ?? [])]) if (playUci(brief.fen, c.uci)) allowed.add(c.uci);
  // The opponent's threat, legal where it would be played: after the move, or in `fen` after a pass.
  const from = brief.threat ? threatFen(brief) : undefined;
  if (brief.threat && from && playUci(from, brief.threat.uci)) allowed.add(brief.threat.uci);
  if (brief.move) {
    const played = playUci(brief.fen, brief.move.uci);
    if (played) {
      allowed.add(played.uci);
      for (const r of brief.replies ?? []) if (playUci(played.fenAfter, r.uci)) allowed.add(r.uci);
    }
  }
  return allowed;
}

/**
 * The moves of the Engine's line after a move the Player asked about, or after a tempting move the
 * Engine didn't list, each legal where the line plays it. The Coach may name them, but never draw
 * them: the board shows the position before the line, where they aren't played.
 */
export function askedLineMoves(brief: Brief): Set<string> {
  const out = new Set<string>();
  for (const c of [...brief.candidates.filter((x) => x.asked), ...(brief.tempting ?? [])]) {
    let played = playUci(brief.fen, c.uci);
    for (const san of c.line.split(' ').filter(Boolean)) {
      played = played && playSan(played.fenAfter, san);
      if (!played) break;
      out.add(played.uci);
    }
  }
  return out;
}

/**
 * The moves the Engine's answers to the Coach's questions gave it, split as the brief's are: those
 * played on the board the Player sees (the brief's position, or after the move) may be drawn, and
 * the rest, deeper in a line, only named. Only the backend's own tool fills `answered`, never a
 * client (ADR 0007), and a line the Coach asked about is its question, not an answer: its moves
 * aren't in it.
 */
export function answeredMoves(brief: Brief, answered: readonly EngineMove[]): { drawn: Set<string>; named: Set<string> } {
  const shown = new Set([positionKey(brief.fen)]);
  const afterMove = brief.move && playUci(brief.fen, brief.move.uci);
  if (afterMove) shown.add(positionKey(afterMove.fenAfter));
  const drawn = new Set<string>();
  const named = new Set<string>();
  for (const { fen, uci } of answered) {
    const played = playUci(fen, uci);
    if (!played) continue;
    (shown.has(positionKey(fen)) ? drawn : named).add(played.uci);
  }
  return { drawn, named };
}

/**
 * What a Hint says instead of words that name a move: the brief asked for the idea alone, and the
 * guard can't cut the move out of a sentence and keep it true.
 */
export const HINT_FALLBACK = 'Look at every check, capture and threat in this position, for both sides, before you choose your move.';

/** How a move may be written: its SAN with or without x, = and + or #, the piece and square alone, or its UCI. */
function spellings(san: string, uci: string): { exact: string[]; anyCase: string[] } {
  const base = san.replace(/[+#!?]+$/, '');
  const exact = new Set([base, base.replace('x', ''), base.replace('=', ''), base.replace('x', '').replace('=', '')]);
  // A piece move without the letter or number that tells two pieces apart: Rd1 for Rdd1.
  const piece = /^([KQRBN])[a-h]?[1-8]?(x?)([a-h][1-8])$/.exec(base);
  if (piece) for (const x of ['', 'x']) exact.add(`${piece[1]}${x}${piece[3]}`);
  if (base.startsWith('O-O')) exact.add(base.replace(/O/g, '0'));
  return { exact: [...exact], anyCase: [uci, `${uci.slice(0, 2)}-${uci.slice(2)}`] };
}

/**
 * The first move `text` names in `fen`, as `spellings` writes it, or undefined. A pawn's move to a
 * square is written as the square alone ("e5"), so that counts only for the Engine's own moves
 * (`engineMoves`): any other square ("your rook on g7", "the rook takes on g7") says where pieces
 * stand, which a Hint may, and the prompt keeps the move itself out of the words.
 */
export function namedMove(text: string, fen: string, engineMoves: ReadonlySet<string>): string | undefined {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\=-]/g, '\\$&');
  for (const uci of legalMoves(fen)) {
    const played = playUci(fen, uci);
    if (!played) continue;
    const { exact, anyCase } = spellings(played.san, played.uci);
    const words = exact.filter((s) => !SQUARE.test(s) || engineMoves.has(played.uci));
    const found =
      words.some((s) => new RegExp(`(?<![A-Za-z0-9])${escape(s)}(?![A-Za-z0-9])`).test(text)) ||
      anyCase.some((s) => new RegExp(`(?<![A-Za-z0-9])${escape(s)}(?![A-Za-z0-9])`, 'i').test(text));
    if (found) return played.san;
  }
  return undefined;
}

export function guardReply(brief: Brief, raw: CoachRawReply, answered: readonly EngineMove[] = []): GuardResult {
  const allowed = brief.hideMoves ? new Set<string>() : allowedMoves(brief);
  const named = brief.hideMoves ? new Set<string>() : askedLineMoves(brief);
  if (!brief.hideMoves) {
    const fromAnswers = answeredMoves(brief, answered);
    for (const uci of fromAnswers.drawn) allowed.add(uci);
    for (const uci of fromAnswers.named) named.add(uci);
  }
  const stripped: string[] = [];

  const moves: string[] = [];
  for (const uci of raw.moves) {
    if (allowed.has(uci) || named.has(uci)) {
      if (!moves.includes(uci)) moves.push(uci);
    } else stripped.push(`move ${uci} is not in the Engine's output`);
  }

  const arrows: Arrow[] = [];
  for (const a of raw.arrows) {
    // An overview has no board of its own to draw on: its moves are played all over the game.
    if (brief.game) {
      stripped.push(`arrow ${a.uci}: an overview draws no arrows`);
      continue;
    }
    if (!allowed.has(a.uci)) {
      stripped.push(`arrow ${a.uci} is not in the Engine's output`);
      continue;
    }
    if (arrows.length >= MAX_ARROWS) continue;
    arrows.push({ from: a.uci.slice(0, 2), to: a.uci.slice(2, 4), brush: a.brush });
  }

  const highlights = brief.hideMoves || brief.game
    ? []
    : [...new Set(raw.highlights.filter((s) => SQUARE.test(s)))].slice(0, MAX_HIGHLIGHTS);

  let note: string | null = null;
  if (raw.note && brief.allowNote) {
    const line = raw.note.replace(/\s+/g, ' ').trim();
    if (line) note = line.length > MAX_NOTE ? `${line.slice(0, MAX_NOTE - 1)}…` : line;
  }
  // A Hint's words name no move either: one that does is not passed on (ADR 0002).
  let text = raw.text;
  if (brief.hideMoves) {
    const engineMoves = new Set([...brief.candidates, ...(brief.tempting ?? [])].map((c) => c.uci));
    const leak = namedMove(text, brief.fen, engineMoves);
    if (leak) {
      stripped.push(`text names ${leak}, which a Hint keeps back`);
      text = HINT_FALLBACK;
    }
  }
  return { text, moves, arrows, highlights, note, stripped };
}
