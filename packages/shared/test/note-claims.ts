// The simple claims a Lesson's notes make about the board, read from a small set of phrasings and
// checked against the positions the note belongs to (issue #37). Most errors the chess review found
// were in notes, not moves: a material count, which piece guards a square, "the only move". This
// does not read free text in general. It matches the phrasings listed below, and a sentence that
// matches none of them is simply not checked. A claim that matches a phrasing but can't be pinned
// down (a piece named without its side or square when both sides have one, a list cut short by
// words the phrasings don't cover) is counted as skipped, never passed. A claim with "no", "not",
// "never", "any" or "every" just before it ("no pawn attacks e4") is not read.
//
// TRUE IN ANY OF ITS POSITIONS. A note is read while its line plays out, so a claim is checked
// against every position it may be about (below) and counts as true when it holds in one of them.
// That keeps a claim like "you are a pawn up" true right after a capture that the reply takes back,
// and it lets through a claim that is true in one of those positions but meant about another one:
// "you are a pawn up" said of the position after the reply, when only the position before it is a
// pawn up, passes.
//
// Which positions a claim may be about:
//   - a part's text: the positions from the part's start to its first decision;
//   - a node's note: the positions after its move up to the next decision, or up to the last later
//     move the sentence names; what follows "after <moves>" is about the position those moves lead
//     to (a move given with its number must be that move: "10...exd4" is not the line's 11...exd4),
//     and is not checked when they can't be played;
//   - a material count in the past ("you were …", "you started …"): the part's positions up to the note's;
//   - a guard: the note's own position as well, except "now guards", which is the board after the move.
// What might happen is not checked: a clause with "could"; a clause with "would" and the clauses
// right after it that explain it ("…, because …"); and everything from an "if" or a "once" (not "at
// once") to the end of its sentence, which is all of a sentence that starts with "If", "Even if" or
// "Once". The rest of the sentence still is: "You are a rook up, so if Black waits you win" checks
// "You are a rook up". Clauses are split at commas and before "because", "but", "so" and "while".
// Curly apostrophes count as straight ones.
//
// Covered phrasings (case-insensitive):
//
// Material, counted with the Coach's piece values (pawn 1, knight and bishop 3, rook 5, queen 9; the
// same as `materialBalance` in src/coach/explain.ts):
//   "<amount> up | down | ahead | behind", where <amount> is "a pawn", "two pawns", "a (whole) piece",
//   "a knight", "the exchange", "3 points", "a rook and two pawns", "a knight down for a pawn", or a
//   bare number of points ("now 3 ahead"). Whose count it is: the last "you", "White" or "Black"
//   before it in the note that is a subject, not "White's", "the black king" or "Black pieces"; "you"
//   is the side the Player plays.
//   "ahead | behind | up | down in material": the same side's count is above or below level.
//   "<you | White | Black> has | have an | one | two extra <pawn | knight | bishop | rook | queen>": that
//   side has that many more of them than the other side.
//   "the material (, …,) is | stays | remains level | equal | even", "equal material": the counts are level.
//   "the pawns are level": each side has as many pawns.
//
// Guards, checked against the squares a piece attacks (chessops, as the Coach's facts):
//   "<pieces> [now|also|still|already|both|only] guards | defends | protects | covers | attacks
//   <targets>", where a piece is named by its square ("your rook on c1", "the g3 pawn", "your pawns
//   on b4 and d4"), or without one ("your king", "the rook": any piece of that kind and side; with
//   no side, the side of the others in its list, or of the note's moved piece when it is that kind of
//   piece, or the side its target implies), and a
//   target is a square ("g8"), a piece, or "the whole <nth> rank | <x>-file". The passive reads the
//   same: "<targets> is | are guarded | defended | protected | covered | attacked by <pieces>" and
//   "<piece>, guarded | defended | protected by <pieces>". Two items joined by ", and" are two clauses,
//   not a list ("pins it to the king, and your queen guards the rook"). A target given as a pronoun ("guards it") is
//   not checked. "Guards", "defends" and "protects" a piece mean one of the same side's that can
//   take back on it, counted as `loosePieces` in explain.ts counts defenders: after the other side's
//   cheapest legal capture there, the defender's capture back must be legal (so neither a pinned
//   piece nor a king whose square the other side still attacks defends it). "Attacks" a piece means
//   one of the other side's. A piece standing in the way blocks: a battery's back piece guards
//   nothing past the front one.
//   "<pieces> guards | defends | protects it there" and "…, where <pieces> guards it", in a move's
//   note: "it" is the moved piece on the square it moved to, after the move.
//   "only <piece> guards <target>": as above, and no other piece of that side defends the target.
//   "nothing guards | defends | protects <piece>": no piece of its side defends it.
//   "no white | black piece guards | covers <target>": no piece of that side attacks it.
//
// The only move, against the legal moves (the Coach's `only-move` fact):
//   "<move> is the only legal move", "It is the only legal move" (the note's move), a sentence that
//   starts "The only legal move" (the note's move), "leaves <move> as <side>'s only legal move",
//   "<side>'s only (legal) move is", "is <side>'s only (legal) move", "the <piece>'s only move is to
//   <square>", "its only move is to take the <piece>" (some piece of the side to move has that one
//   legal move). A <move> may carry its number and a "!" or "?".
//   "<square> is the | its only (safe) square", "the only (safe) square (left) (for <piece>) is
//   <square>", "the <piece>'s only (safe) square is <square>", "to <square>, the only (safe) square":
//   about the note's moved piece when its move goes to that square (in the note's own position),
//   else the side to move's king (or the piece named) in the position after the move. A safe square is one the other
//   side doesn't attack once the piece stands there.
// The only move that doesn't lose, against the Engine (`noteClaims(…).holds`, checked by
// packages/backend/test/lesson-note-holds.test.ts):
//   "<move> | It is the only move that holds | draws | saves the game | doesn't lose", "It is the only
//   good move", "any | every other move (here) loses | allows mate" (about the note's move, or the
//   reply when the sentence says the other side "has to" or "must"), and "<side>'s only defence |
//   answer | reply | way out (of check) is": the only legal move, or else the only move that doesn't lose.
import { attacks, between, ray } from 'chessops/attacks';
import { makeFen } from 'chessops/fen';
import { SquareSet } from 'chessops/squareSet';
import type { Role } from 'chessops/types';
import { makeSquare, parseSquare } from 'chessops/util';
import { legalMoves, moveNumberOf, playSan, playUci, positionFromFen, sansIn, turnOf, type Side } from '../src/chess.ts';
import { moveFacts } from '../src/coach/explain.ts';
import type { LessonData } from '../src/content/lessons.ts';
import { nullMoveFen } from '../src/threat.ts';

export type ClaimKind = 'material' | 'guards' | 'only-move';

/** One claim read from a note, and why it is false, if it is. */
export interface NoteClaim {
  kind: ClaimKind;
  /** "forks part 2 text" or "forks part 2 Nd6+". */
  at: string;
  /** The words the claim was read from. */
  phrase: string;
  /** Why the board says otherwise; undefined when the claim is true. */
  problem?: string;
}

/** A claim that matched a phrasing but could not be pinned down, so it was neither passed nor failed. */
export interface SkippedClaim {
  kind: ClaimKind;
  at: string;
  phrase: string;
  why: string;
}

/** A claim that a move is the only one that doesn't lose: the Engine decides it, so it is checked in the backend. */
export interface HoldClaim {
  at: string;
  phrase: string;
  /** The position the claim is about. */
  fen: string;
  /** The move the note says is the only one that holds, in UCI. */
  uci: string;
}

/** A ply of a part's main line. */
interface Ply {
  fen: string;
  uci: string;
  san: string;
  fenAfter: string;
}

/** A note and the positions it belongs to. */
interface Note {
  at: string;
  text: string;
  /** The side the Player plays. */
  you: Side;
  /** The part's positions up to the note's own, for claims in the past tense. */
  before: string[];
  /** The positions the note's present-tense claims are about. */
  after: string[];
  /** The main line from the note's position on, to look up the moves it names. */
  line: Ply[];
  /** How many plies of `line` the note's `after` covers. */
  reach: number;
  /** The move the note explains, when it belongs to a node. */
  move?: Ply;
}

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const UNIT_POINTS: Record<string, number> = { pawn: 1, piece: 3, knight: 3, bishop: 3, rook: 5, queen: 9, point: 1 };
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ROLES: readonly Role[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];

// --- The phrasings ---------------------------------------------------------------------------------

const NUM = String.raw`(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)`;
const UNIT = String.raw`(?:whole )?(?:pawns?|pieces?|knights?|bishops?|rooks?|queens?|points?)`;
const ITEM = String.raw`(?:${NUM} ${UNIT}|the exchange|an exchange)`;
const MATERIAL = new RegExp(String.raw`\b(${ITEM}(?: and ${ITEM})*|\d+) (up|down|ahead|behind)(?: for (${NUM} ${UNIT}))?\b`, 'gi');
const IN_MATERIAL = /\b(ahead|behind|up|down) in material\b/gi;
const EXTRA = /\b(you|white|black) (?:still )?(?:has|have) (an|one|two|three|four) extra (pawn|knight|bishop|rook|queen)s?\b/gi;
const LEVEL = /\b(?:(?:the )?material(?:, [^,.;:]+,)? (?:is|stays|remains) (?:now |still |again )?(?:level|equal|even)|(?:equal|level|even) material)\b/gi;
const PAWNS_LEVEL = /\bthe pawns are (?:now |still )?(?:level|equal|even)\b/gi;

const SQ = '[a-h][1-8]';
const SIDE_WORD = String.raw`(?:your(?: own)?|black's(?: own)?|white's(?: own)?|the black|the white|the)`;
const ROLE = '(?:king|queen|rook|bishop|knight|pawn)';
const PLURAL = '(?:pawns|knights|bishops|rooks)';
/** A piece: by its square ("your rook on c1", "the g3 pawn"), several on their squares, or alone of its kind ("your king"). */
const PIECE = String.raw`(?:(?:${SIDE_WORD} )?${ROLE} on ${SQ}|(?:${SIDE_WORD} )?${SQ} ${ROLE}|(?:${SIDE_WORD} )?${PLURAL} on ${SQ}(?:, ${SQ})*,? and ${SQ}|${SIDE_WORD} ${ROLE})(?![\w-])`;
/** A list: "A and B", or "A, B and C"; two items joined by ", and" are two clauses ("… to the king, and your queen guards …"). */
const list = (item: string, more = item) => String.raw`${item}(?:(?:, ${more})+,? and ${more}| and ${more})?`;
/** Words after a list item that make it the subject of the next clause: "…, and the king has no square left". */
const NEXT_CLAUSE = String.raw`(?! (?:has|have|is|are|was|can|cannot|must|stands?|moves?|goes|takes?|checks?|gives?|blocks?|${'(?:guards?|defends?|protects?|covers?|attacks?)'})\b)`;
const PIECES = list(PIECE, String.raw`(?:${PIECE}|${ROLE} on ${SQ})`);
const BY_PIECES = list(PIECE, String.raw`(?:${PIECE}|${ROLE} on ${SQ})${NEXT_CLAUSE}`);
const TARGET = String.raw`(?:${PIECE}|${SQ}\b|the whole (?:${ORDINALS.join('|')}) rank|the whole [a-h]-file)`;
const GUARD_VERB = '(?:guards?|defends?|protects?|covers?|attacks?)';
const ADVERBS = '(?:(?:now|also|still|already|both|only|then|well) )*';
// A target followed by a verb is the next clause's subject ("attacks your queen, and the pawn on f5 attacks …").
const TARGETS = list(TARGET, String.raw`${TARGET}(?! ${ADVERBS}${GUARD_VERB}\b)${NEXT_CLAUSE}`);
const GUARDS = new RegExp(String.raw`(?<![\w'-])(only )?(${PIECES}) ${ADVERBS}(${GUARD_VERB}) (${TARGETS})`, 'gi');
const GUARDED_BY = new RegExp(String.raw`(?<![\w'-])(${TARGETS}) (?:is|are) ${ADVERBS}(guarded|defended|protected|covered|attacked) (?:twice |once )?by (${BY_PIECES})`, 'gi');
const COMMA_GUARDED_BY = new RegExp(String.raw`(?<![\w'-])(${PIECE}), ${ADVERBS}(guarded|defended|protected) by (${BY_PIECES})`, 'gi');
/** "Your rook on c1 guards it there", "…, where your queen guards it": "it" is the note's moved piece where it lands. */
const GUARDS_IT_THERE = new RegExp(String.raw`(?:(?<![\w'-])(${PIECES}) ${ADVERBS}(guards?|defends?|protects?) it there\b|\bwhere (${PIECES}) ${ADVERBS}(guards?|defends?|protects?) it\b)`, 'gi');
const NOTHING_GUARDS = new RegExp(String.raw`\bnothing (?:now )?(?:guards|defends|protects) (${PIECE})`, 'gi');
const NO_PIECE_GUARDS = new RegExp(String.raw`\bno (white|black) piece (?:now )?(?:guards|covers|attacks) (${TARGET})`, 'gi');
const ACTIVE: Record<string, string> = { guarded: 'guards', defended: 'defends', protected: 'protects', covered: 'covers', attacked: 'attacks' };

// A move as a note writes it, with or without its number and with any "!" or "?" after it: "85.Kg1", "8...Kd2", "Kg1!".
const SAN = String.raw`(?:\d+\.+ ?)?([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?[+#]?|O-O-O|O-O)[!?]*`;
/** A move written in a sentence, as "after <moves>" names them: "8...Qxg4", "exd4", "O-O". */
const MOVE_WORD = String.raw`(?:\d+\.+ ?)?(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=?[QRBN])?|O-O(?:-O)?)[+#]?[!?]*(?![\w-])`;
const ONLY_LEGAL_SAN = new RegExp(String.raw`(?<![\w.])${SAN} is the only legal move\b`, 'g');
const ONLY_LEGAL_IT = /\b(?:it|this) is the only legal move\b|^the only legal move\b/i;
const LEAVES_ONLY = new RegExp(String.raw`\bleaves ${SAN} as (white|black)'s only legal move\b`, 'gi');
const SIDE_ONLY_MOVE = /\b(white|black)'s only (?:legal )?move is\b|\bis (white|black)'s only (?:legal )?move\b/gi;
const PIECE_ONLY_MOVE = /\bthe (king|queen|rook|bishop|knight)'s only (?:legal )?move is to ([a-h][1-8])\b/gi;
const ITS_ONLY_TAKE = /\bits only (?:legal )?move is to take the (queen|rook|bishop|knight|pawn)\b/gi;
const ONLY_SQUARE = [
  /\b([a-h][1-8]) is (?:the|its) only (safe )?square\b()/gi,
  /\bthe only (safe )?square (?:left )?(?:for (?:white's |black's |the |your )?(king|queen|rook|bishop|knight) )?is ([a-h][1-8])\b/gi,
  /\b(?:the )?(?:(?:white|black|white's|black's|your) )?(king|queen|rook|bishop|knight)'s only (safe )?square is ([a-h][1-8])\b/gi,
  /\bto ([a-h][1-8]), the only (safe )?square\b()/gi,
];
const SIDE_ONLY_DEFENCE = /\b(white|black)'s only (?:defence|defense|answer|reply|way out(?: of (?:the )?check)?) is\b/gi;
const HOLDS = new RegExp(String.raw`(?:(?<![\w.])${SAN}|\b(it|this)) is the only (?:good move|move that (?:holds|draws|saves the game|does not lose|doesn't lose))\b`, 'gi');
const ANY_OTHER = /\b(?:any|every) other move (?:here )?(?:loses|allows (?:a )?mate)\b/gi;

// --- Reading the notes -----------------------------------------------------------------------------

/** A note with curly apostrophes made straight, so "White’s only move" reads like "White's only move". */
const plain = (text: string) => text.replace(/[‘’]/g, "'");

/** Every note of a Lesson that sits on a board: each part's text and each node's notes. */
function notesOf(lesson: LessonData): Note[] {
  const out: Note[] = [];
  lesson.parts.forEach((part, p) => {
    const line: Ply[] = part.nodes.map((n) => {
      const played = playUci(n.fen, n.main);
      if (!played) throw new Error(`${lesson.id} part ${p + 1}: ${n.mainSan} is illegal`);
      return { fen: n.fen, uci: n.main, san: played.san, fenAfter: played.fenAfter };
    });
    const firstDecision = Math.max(0, part.nodes.findIndex((n) => n.decision));
    if (part.text) {
      const start = line.slice(0, firstDecision + 1).map((x) => x.fen);
      out.push({ at: `${lesson.id} part ${p + 1} text`, text: plain(part.text), you: part.side, before: start, after: start, line, reach: firstDecision });
    }
    part.nodes.forEach((node, i) => {
      if (!node.notes?.text) return;
      const move = line[i] as Ply;
      let next = part.nodes.findIndex((n, j) => j > i && n.decision);
      if (next < 0) next = line.length;
      const after = line.slice(i, next).map((x) => x.fenAfter);
      out.push({ at: `${lesson.id} part ${p + 1} ${node.mainSan}`, text: plain(node.notes.text), you: part.side, before: line.slice(0, i + 1).map((x) => x.fen), after, line: line.slice(i), reach: next - i, move });
    });
  });
  return out;
}

/** A sentence of a note, with its hypothetical clauses blanked out, and the positions it may be about. */
interface Sentence {
  text: string;
  /** The note's text before it, where a count's subject may be: "You are White, 2 points behind: a knight down for a pawn." */
  lead: string;
  after: string[];
}

/**
 * A note's sentences, each with the positions it may be about: a sentence that names later moves of
 * the line reaches up to them, and one that starts "After <moves>" is about the position those moves
 * lead to, played on from the note's line (or not checked, when they can't be played).
 */
function sentencesOf(note: Note): Sentence[] {
  const out: Sentence[] = [];
  let lead = '';
  // A sentence ends at a colon, a semicolon, or a stop followed by a capital, a number or a bracket,
  // so "1.e4! is the only legal move" stays whole.
  // "…, but after 10...exd4 the pawn attacks …": what follows "after <moves>" is about the position they lead to.
  const pieces = note.text.split(/(?<=[;:])\s+|(?<=[.!?)])\s+(?=[A-Z0-9(])/).flatMap((s) => s.split(new RegExp(String.raw`(?<=\S )(?=after ${MOVE_WORD})`)));
  for (const raw of pieces) {
    const sentence = reading(note, raw, lead);
    lead += `${raw} `;
    if (sentence) out.push(sentence);
  }
  return out;
}

/** Marks a blanked-out clause, so no phrasing reads across it. */
const BLANK = ' … ';

/**
 * `text` with what might happen blanked out: a clause with "could"; a clause with "would" and the
 * clauses right after it that explain it ("4.Qxf7 would be mate, because the bishop guards the
 * queen"); and everything from an "if" or a "once" to the end. "You are a rook up, so if Black waits
 * you win" keeps "You are a rook up".
 */
export function factual(text: string): string {
  if (/^\(?(?:even )?(?:if|once)\b/i.test(text)) return BLANK;
  const parts = text.split(/(,\s+|\s+(?=(?:because|but|so|while)\s))/);
  let rest = false;
  let explaining = false;
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      // "once" as in "once that pawn has taken", not "at once".
      if (rest || /\bif\b|(?<!\bat )\bonce\b/i.test(part)) {
        rest = true;
        return BLANK;
      }
      // What explains an imagined position is imagined too: "4.Qxf7 would be mate, because the bishop guards the queen".
      if (explaining && /^(?:because|since|as|which|where)\b/i.test(part)) return BLANK;
      explaining = /\bwould\b/i.test(part);
      return explaining || /\bcould\b/i.test(part) ? BLANK : part;
    })
    .join('');
}

function reading(note: Note, raw: string, lead: string): Sentence | undefined {
  const text = factual(raw);
  if (!text.trim() || text === BLANK) return undefined;
  const opening = AFTER_MOVES.exec(raw);
  if (opening) {
    const fen = playedOn(note, opening[0]);
    return fen ? { text, lead, after: [fen] } : undefined;
  }
  let reach = note.reach;
  for (const san of sansIn(text)) {
    const i = note.line.findIndex((x) => sameMove(x, san, text));
    if (i + 1 > reach) reach = i + 1;
  }
  return { text, lead, after: [...note.after, ...note.line.slice(note.reach, reach).map((x) => x.fenAfter)] };
}

const AFTER_MOVES = new RegExp(String.raw`^after ${MOVE_WORD}(?: ${MOVE_WORD})*`, 'i');

/** The position after the moves `text` names, each one taken from the note's line where it is there and played on where it isn't. */
function playedOn(note: Note, text: string): string | undefined {
  let fen = note.after.at(-1) ?? note.before.at(-1);
  for (const m of text.matchAll(new RegExp(MOVE_WORD, 'g'))) {
    const san = m[0].replace(/^\d+\.+ ?/, '');
    const inLine = note.line.find((x) => sameMove(x, san, m[0]));
    const next = inLine ? inLine.fenAfter : fen && playSan(fen, stripped(san))?.fenAfter;
    if (!next) return undefined;
    fen = next;
  }
  return fen;
}

const stripped = (san: string) => san.replace(/[+#!?]+$/, '');

/**
 * Whether `ply` is the move `san`, as `text` names it: with its number when the text gives one
 * ("10...exd4" is not the line's 11...exd4).
 */
function sameMove(ply: Ply, san: string, text: string): boolean {
  if (stripped(ply.san) !== stripped(san)) return false;
  const escaped = stripped(san).replace(/[+]/g, '\\+');
  const numbered = new RegExp(String.raw`(\d+)(\.+) ?${escaped}(?![\w])`).exec(text);
  if (!numbered) return true;
  const black = (numbered[2] as string).length > 1;
  return moveNumberOf(ply.fen) === Number(numbered[1]) && (turnOf(ply.fen) === 'black') === black;
}

// --- The board -------------------------------------------------------------------------------------

/** `side`'s material minus the other side's, in pawns: the Coach's count (`materialBalance` in explain.ts). */
export function materialBalance(fen: string, side: Side): number {
  let total = 0;
  for (const [, piece] of positionFromFen(fen).board) total += piece.color === side ? VALUE[piece.role] : -VALUE[piece.role];
  return total;
}

/** "two pawns" → 2, "a rook" → 5, "the exchange" → 2, "3" → 3. */
function points(amount: string): number {
  return amount
    .toLowerCase()
    .split(' and ')
    .reduce((sum, item) => {
      if (/^\d+$/.test(item)) return sum + Number(item);
      if (/exchange$/.test(item)) return sum + 2;
      const [num, ...rest] = item.split(' ');
      const n = NUMBER_WORDS[num as string] ?? Number(num);
      const unit = (rest.at(-1) as string).replace(/s$/, '');
      return sum + n * (UNIT_POINTS[unit] as number);
    }, 0);
}

/**
 * "you", "White" and "Black" used as a subject: not "White's", nor a colour in front of a noun
 * ("the black king", "Black pieces"), which can't be who is a pawn up.
 */
const SUBJECT = /(?<!\bthe )\b(you|white|black)\b(?!'s)(?! (?:king|queen|rook|bishop|knight|pawn|piece|square)s?\b)/gi;

/** Who a material count is about: the last subject before it. */
function subjectBefore(text: string, you: Side): Side | undefined {
  const last = [...text.matchAll(SUBJECT)].at(-1)?.[1]?.toLowerCase();
  return last === undefined ? undefined : last === 'you' ? you : (last as Side);
}

/** Whether the count is told in the past: "you were …", "you started …", from the last verb after its subject. */
function pastBefore(text: string): boolean {
  const subject = [...text.matchAll(SUBJECT)].at(-1)?.index ?? 0;
  const verbs = [...text.slice(subject).matchAll(/\b(are|is|stay|stays|remain|remains|were|was|started)\b/gi)];
  return /^(were|was|started)$/i.test(verbs.at(-1)?.[1] ?? '');
}

interface Piece {
  side?: Side;
  role: Role;
  /** Undefined for a piece named without its square: it is found on the board when it is the only one. */
  square?: string;
}

function sideOf(word: string | undefined, you: Side): Side | undefined {
  const w = word?.toLowerCase() ?? '';
  if (w.startsWith('your')) return you;
  if (w.startsWith('white') || w === 'the white') return 'white';
  if (w.startsWith('black') || w === 'the black') return 'black';
  return undefined;
}

/** "your rook on c1", "the knight on f7", "White's queen", "the g3 pawn", "your pawns on b4 and d4", "bishop on e7" (taking `inherit`'s side). */
function readPieces(phrase: string, you: Side, inherit?: Side): Piece[] | undefined {
  const t = phrase.trim();
  const single = new RegExp(String.raw`^(?:(${SIDE_WORD}) )?(${ROLE})(?: on (${SQ}))?$`, 'i').exec(t);
  const onSquare = new RegExp(String.raw`^(?:(${SIDE_WORD}) )?(${SQ}) (${ROLE})$`, 'i').exec(t);
  const plural = new RegExp(String.raw`^(?:(${SIDE_WORD}) )?(${PLURAL}) on (.+)$`, 'i').exec(t);
  const side = (word: string | undefined) => (word ? sideOf(word, you) : inherit);
  const piece = (s: Side | undefined, role: Role, square?: string): Piece => ({ ...(s ? { side: s } : {}), role, ...(square ? { square: square.toLowerCase() } : {}) });
  if (single) return [piece(side(single[1]), (single[2] as string).toLowerCase() as Role, single[3])];
  if (onSquare) return [piece(side(onSquare[1]), (onSquare[3] as string).toLowerCase() as Role, onSquare[2])];
  if (plural) {
    const role = (plural[2] as string).toLowerCase().replace(/s$/, '') as Role;
    return [...(plural[3] as string).matchAll(/[a-h][1-8]/gi)].map((m) => piece(side(plural[1]), role, m[0]));
  }
  return undefined;
}

/** A piece the claim names but the board can't tell apart: two rooks for "the rook". */
const AMBIGUOUS = 'ambiguous';

/** Where `piece` stands in `fen`, undefined when it isn't there, or AMBIGUOUS when it is named without its square and isn't the only one. */
function find(fen: string, piece: Piece): number | undefined | typeof AMBIGUOUS {
  const pos = positionFromFen(fen);
  if (piece.square) {
    const sq = parseSquare(piece.square) as number;
    const on = pos.board.get(sq);
    return on && on.role === piece.role && (!piece.side || on.color === piece.side) ? sq : undefined;
  }
  const all = [...(piece.side ? pos.board.pieces(piece.side, piece.role) : pos.board[piece.role])];
  return all.length === 1 ? all[0] : all.length ? AMBIGUOUS : undefined;
}

/**
 * The squares `piece` may stand on in `fen`: its own square, or, named without one, every piece of
 * its kind and side ("your rook" is true of either rook). AMBIGUOUS when neither its square nor its
 * side is known and both sides have such a piece ("the king").
 */
function candidates(fen: string, piece: Piece): number[] | typeof AMBIGUOUS {
  const pos = positionFromFen(fen);
  if (piece.square) {
    const at = find(fen, piece);
    return typeof at === 'number' ? [at] : [];
  }
  if (piece.side) return [...pos.board.pieces(piece.side, piece.role)];
  const white = [...pos.board.pieces('white', piece.role)];
  const black = [...pos.board.pieces('black', piece.role)];
  return white.length && black.length ? AMBIGUOUS : [...white, ...black];
}

type Target = { piece: Piece } | { squares: string[]; name: string };

function readTargets(phrase: string, you: Side): Target[] | undefined {
  const out: Target[] = [];
  // "your pawns on b4 and d4" is one target; split the list only between targets.
  for (const item of phrase.split(new RegExp(String.raw`(?:, and |, | and )(?=(?:${SIDE_WORD} )?(?:${ROLE}|${PLURAL}|${SQ}\b|the whole))`, 'i'))) {
    const t = item.trim().toLowerCase();
    if (/^[a-h][1-8]$/.test(t)) {
      out.push({ squares: [t], name: t });
      continue;
    }
    const rank = /^the whole (\w+) rank$/.exec(t);
    if (rank) {
      const r = ORDINALS.indexOf(rank[1] as string) + 1;
      out.push({ squares: 'abcdefgh'.split('').map((f) => `${f}${r}`), name: t });
      continue;
    }
    const file = /^the whole ([a-h])-file$/.exec(t);
    if (file) {
      out.push({ squares: [1, 2, 3, 4, 5, 6, 7, 8].map((r) => `${file[1]}${r}`), name: t });
      continue;
    }
    const pieces = readPieces(t, you);
    if (!pieces) return undefined;
    for (const piece of pieces) out.push({ piece });
  }
  return out;
}

/** Splits "your queen and your bishop on f6" into its pieces, a bare "bishop on e7" taking the side before it. */
function readSubjects(phrase: string, you: Side): Piece[] | undefined {
  const out: Piece[] = [];
  for (const item of phrase.split(new RegExp(String.raw`(?:,? and |, )(?=(?:${SIDE_WORD} )?(?:${ROLE}|${PLURAL}|${SQ} pawn))`, 'i'))) {
    const pieces = readPieces(item, you, out[0]?.side);
    if (!pieces) return undefined;
    out.push(...pieces);
  }
  return out.length ? out : undefined;
}

function other(side: Side): Side {
  return side === 'white' ? 'black' : 'white';
}

/** A move onto `to`, promoting to a queen if it is a pawn reaching the last rank. */
function moveTo(pos: ReturnType<typeof positionFromFen>, from: number, to: number) {
  const promotes = pos.board.get(from)?.role === 'pawn' && (to >> 3 === 0 || to >> 3 === 7);
  return { from, to, ...(promotes ? { promotion: 'queen' as const } : {}) };
}

/**
 * Whether the piece on `from` can take back on `at` once the other side has taken there with its
 * cheapest legal capture, the way `loosePieces` in explain.ts counts a defender: undefined when the
 * other side has no legal capture there (or can't be put to move), so only the attack counts.
 */
function takesBack(fen: string, from: number, at: number): boolean | undefined {
  const pos = positionFromFen(fen);
  const target = pos.board.get(at);
  if (!target) return undefined;
  const enemy = other(target.color);
  const swapped = pos.turn === enemy ? fen : nullMoveFen(fen);
  if (!swapped) return undefined;
  const mover = positionFromFen(swapped);
  const takers = [...mover.board[enemy]].filter((s) => mover.dests(s).has(at));
  if (!takers.length) return undefined;
  const rank = (s: number) => {
    const role = mover.board.get(s)?.role as Role;
    return role === 'king' ? 100 : VALUE[role];
  };
  const cheapest = takers.sort((a, b) => rank(a) - rank(b))[0] as number;
  const next = mover.clone();
  next.play(moveTo(mover, cheapest, at));
  return next.board.get(from)?.color === target.color && next.isLegal(moveTo(next, from, at));
}

/** The line `side`'s piece on `from` is pinned along to its king, or undefined when it isn't pinned. */
function pinLine(fen: string, from: number, side: Side): SquareSet | undefined {
  const pos = positionFromFen(fen);
  const king = pos.board.kingOf(side);
  if (king === undefined || king === from) return undefined;
  const open = pos.board.occupied.without(from);
  for (const s of pos.board[other(side)]) {
    const piece = pos.board.get(s);
    if (!piece || !['bishop', 'rook', 'queen'].includes(piece.role)) continue;
    if (between(king, s).has(from) && attacks(piece, s, open).has(king)) return ray(king, s);
  }
  return undefined;
}

/** Whether `side`'s piece on `from` defends its own piece on `at`: it attacks it and could take back there. */
function defends(fen: string, from: number, at: number, side: Side): boolean {
  const pos = positionFromFen(fen);
  const piece = pos.board.get(from);
  if (!piece || !attacks(piece, from, pos.board.occupied).has(at)) return false;
  const back = takesBack(fen, from, at);
  if (back !== undefined) return back;
  const pin = pinLine(fen, from, side);
  return !pin || pin.has(at);
}

/** The squares of `side`'s pieces that attack `sq`. */
function attackersOf(fen: string, sq: number, side: Side): SquareSet {
  const pos = positionFromFen(fen);
  let out = SquareSet.empty();
  for (const s of pos.board[side]) if (attacks(pos.board.get(s) as { role: Role; color: Side }, s, pos.board.occupied).has(sq)) out = out.with(s);
  return out;
}

/** The squares of `side`'s pieces that defend its piece on `sq` (or, on a square with no piece of `side`, attack it). */
function defendersOf(fen: string, sq: number, side: Side): number[] {
  const own = positionFromFen(fen).board.get(sq)?.color === side;
  return [...attackersOf(fen, sq, side)].filter((s) => !own || defends(fen, s, sq, side));
}

function describe(p: Piece): string {
  return `${p.side ? `${p.side} ` : ''}${p.role}${p.square ? ` on ${p.square}` : ''}`;
}

/**
 * Why `by` doesn't `verb` `target` in `fen`, undefined when it does, or AMBIGUOUS when the board can't
 * tell which piece is meant. A piece named without its square stands for any piece of its kind: the
 * claim is true when one of them makes it true.
 */
function guardProblem(fen: string, by: Piece, verb: string, target: Target, only: boolean): string | undefined {
  const wantsOwn = /^(guard|defend|protect)/i.test(verb);
  const wantsOther = /^attack/i.test(verb);
  // "The queen also attacks your pawn": the side of a piece named without one follows from its target.
  const targetSide = 'piece' in target ? target.piece.side : undefined;
  const subject = by.side || by.square || !targetSide ? by : { ...by, side: wantsOther ? other(targetSide) : wantsOwn ? targetSide : undefined };
  const froms = candidates(fen, subject);
  if (froms === AMBIGUOUS) return AMBIGUOUS;
  if (!froms.length) return `there is no ${describe(subject)}`;
  let first: string | undefined;
  for (const from of froms) {
    const problem = oneGuardProblem(fen, from, subject, wantsOwn, wantsOther, target, only);
    if (problem === undefined) return undefined;
    if (problem !== AMBIGUOUS) first ??= problem;
  }
  return first ?? AMBIGUOUS;
}

function oneGuardProblem(fen: string, from: number, by: Piece, wantsOwn: boolean, wantsOther: boolean, target: Target, only: boolean): string | undefined {
  const pos = positionFromFen(fen);
  const side = pos.board.get(from)?.color as Side;
  const hits = attacks(pos.board.get(from) as { role: Role; color: Side }, from, pos.board.occupied);
  const name = describe({ ...by, side, square: makeSquare(from) });
  const onlyOne = (squares: number[]) => {
    if (!only) return undefined;
    for (const sq of squares) {
      const others = defendersOf(fen, sq, side).filter((s) => s !== from);
      if (others.length) return `${others.map(makeSquare).join(', ')} also guard ${makeSquare(sq)}`;
    }
    return undefined;
  };
  if ('squares' in target) {
    const squares = target.squares.map((s) => parseSquare(s) as number).filter((s) => s !== from);
    const missed = squares.filter((s) => !hits.has(s));
    return missed.length ? `the ${name} does not reach ${missed.map(makeSquare).join(', ')}` : onlyOne(squares);
  }
  // A piece named without side or square is looked for on the side the verb says: guarded ones are the guard's own.
  const named = target.piece.side || target.piece.square ? target.piece : { ...target.piece, ...(wantsOwn ? { side } : wantsOther ? { side: other(side) } : {}) };
  const ats = candidates(fen, named);
  if (ats === AMBIGUOUS) return AMBIGUOUS;
  if (!ats.length) return `there is no ${describe(named)}`;
  let first: string | undefined;
  for (const at of ats) {
    const atSide = pos.board.get(at)?.color as Side;
    const problem =
      wantsOwn && atSide !== side ? `the ${describe(named)} is not ${side}'s`
      : wantsOther && atSide === side ? `the ${describe(named)} is ${side}'s own`
      : !hits.has(at) ? `the ${name} does not attack ${makeSquare(at)}`
      : atSide === side && !defends(fen, from, at, side) ? `the ${name} could not take back on ${makeSquare(at)}`
      : onlyOne([at]);
    if (problem === undefined) return undefined;
    first ??= problem;
  }
  return first;
}

/** The ply of the note's line that plays `san`, as the Player would read it. */
function plyOf(note: Note, san: string, text: string): Ply | undefined {
  return note.line.find((x) => sameMove(x, san, text));
}

// --- Checking --------------------------------------------------------------------------------------

interface Claims {
  claims: NoteClaim[];
  holds: HoldClaim[];
  skipped: SkippedClaim[];
}

/** Every claim in a Lesson's notes that the phrasings cover, each checked on the board. */
export function noteClaims(lesson: LessonData): Claims {
  const out: Claims = { claims: [], holds: [], skipped: [] };
  for (const note of notesOf(lesson)) {
    for (const sentence of sentencesOf(note)) {
      /**
       * Records a claim from the problems it has in each of its positions: true when it holds in one,
       * skipped when it holds in none but the board can't tell which piece one of them means.
       */
      const add = (kind: ClaimKind, phrase: string, problems: readonly (string | undefined)[]) => {
        if (problems.some((p) => p === undefined)) out.claims.push({ kind, at: note.at, phrase });
        else if (problems.some((p) => p === AMBIGUOUS)) out.skipped.push({ kind, at: note.at, phrase, why: 'names a piece without its side or square, and both sides have one' });
        else out.claims.push({ kind, at: note.at, phrase, problem: problems.filter((p) => p !== AMBIGUOUS).at(-1) as string });
      };
      const skip = (kind: ClaimKind, phrase: string, why: string) => out.skipped.push({ kind, at: note.at, phrase, why });
      materialClaims(note, sentence, add);
      guardClaims(note, sentence, add, skip);
      onlyMoveClaims(note, sentence, add, out.holds);
    }
  }
  const seen = new Set<string>();
  out.holds = out.holds.filter((h) => {
    const key = `${h.at} ${h.fen} ${h.uci}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
  return out;
}

type Add = (kind: ClaimKind, phrase: string, problems: readonly (string | undefined)[]) => void;
type Skip = (kind: ClaimKind, phrase: string, why: string) => void;

const signed = (n: number) => (n > 0 ? `${n} up` : n < 0 ? `${-n} down` : 'level');

function materialClaims(note: Note, sentence: Sentence, add: Add): void {
  for (const m of sentence.text.matchAll(MATERIAL)) {
    const head = sentence.lead + sentence.text.slice(0, m.index);
    const side = subjectBefore(head, note.you);
    if (!side) continue;
    const amount = m[1] as string;
    // A bare number counts only as points: "now 3 ahead", after "2 points behind".
    if (/^\d+$/.test(amount) && !/points?/i.test(sentence.text)) continue;
    const sign = /up|ahead/i.test(m[2] as string) ? 1 : -1;
    const want = sign * points(amount) - sign * (m[3] ? points(m[3]) : 0);
    const positions = pastBefore(head) ? note.before : sentence.after;
    add('material', m[0], positions.map((fen) => {
      const have = materialBalance(fen, side);
      return have === want ? undefined : `${side} is ${signed(have)}, not ${signed(want)}`;
    }));
  }
  for (const m of sentence.text.matchAll(IN_MATERIAL)) {
    const head = sentence.lead + sentence.text.slice(0, m.index);
    const side = subjectBefore(head, note.you);
    if (!side) continue;
    const ahead = /ahead|up/i.test(m[1] as string);
    const positions = pastBefore(head) ? note.before : sentence.after;
    add('material', m[0], positions.map((fen) => {
      const have = materialBalance(fen, side);
      return (ahead ? have > 0 : have < 0) ? undefined : `${side} is ${signed(have)}`;
    }));
  }
  for (const m of sentence.text.matchAll(EXTRA)) {
    const who = (m[1] as string).toLowerCase();
    const side: Side = who === 'you' ? note.you : (who as Side);
    const n = NUMBER_WORDS[(m[2] as string).toLowerCase()] as number;
    const role = (m[3] as string).toLowerCase() as Role;
    add('material', m[0], sentence.after.map((fen) => {
      const board = positionFromFen(fen).board;
      const more = board.pieces(side, role).size() - board.pieces(other(side), role).size();
      return more === n ? undefined : `${side} has ${more} more ${role}s, not ${n}`;
    }));
  }
  for (const m of sentence.text.matchAll(LEVEL)) {
    add('material', m[0], sentence.after.map((fen) => {
      const have = materialBalance(fen, 'white');
      return have === 0 ? undefined : `White is ${signed(have)}, not level`;
    }));
  }
  for (const m of sentence.text.matchAll(PAWNS_LEVEL)) {
    add('material', m[0], sentence.after.map((fen) => {
      const board = positionFromFen(fen).board;
      const w = board.pieces('white', 'pawn').size();
      const b = board.pieces('black', 'pawn').size();
      return w === b ? undefined : `White has ${w} pawns and Black ${b}`;
    }));
  }
}

/** Words right after a list that look like one more piece the phrasings couldn't read: the list was cut short. */
const CUT_AFTER = new RegExp(String.raw`^ and (?:(?:the|your|black's|white's) )?(?:own )?${ROLE}s?\b${NEXT_CLAUSE}(?! (?:on|and|,)\b)`, 'i');
/** Words right before a subject that look like one more piece of it: "the g3 pawn and …" when that is not read. */
const CUT_BEFORE = new RegExp(String.raw`\b${ROLE}s?(?: on [a-h][1-8])? and $`, 'i');
/** Words right before a claim that deny or widen it: "no pawn attacks …", "a knight on e5 would …". */
const NEGATED = /\b(?:no|not|never|nothing|neither|nor|any|every|each)(?: (?:white|black|other|single))? $/i;

function guardClaims(note: Note, sentence: Sentence, add: Add, skip: Skip): void {
  const text = sentence.text;
  // The note's own position and the ones after its move: a guard is about the board as it is now.
  const positions = [...note.before.slice(-1), ...sentence.after];
  /** The note's moved piece: "the knight" in the note on Nf3 is that knight's side's. */
  const moved = note.move ? positionFromFen(note.move.fen).board.get(parseSquare(note.move.uci.slice(0, 2)) as number) : undefined;
  const claim = (m: RegExpMatchArray, only: boolean, verb: string, subjects: string, targets: string, end: number) => {
    const start = m.index ?? 0;
    if (NEGATED.test(text.slice(0, start))) return;
    if (CUT_BEFORE.test(text.slice(0, start)) || CUT_AFTER.test(text.slice(end))) return skip('guards', m[0], 'a list the phrasings read only part of');
    const read = readSubjects(subjects, note.you);
    const to = readTargets(targets, note.you);
    if (!read || !to) return skip('guards', m[0], 'a piece the phrasings cannot place');
    // A piece named without its side takes the side of the others in its list ("The rook and your bishop on d6"),
    // or, when it is the kind of piece the note's move moved, that piece's side.
    const listSide = read.find((p) => p.side)?.side;
    const by = read.map((p) => (p.side || p.square ? p : listSide ? { ...p, side: listSide } : moved?.role === p.role ? { ...p, side: moved.color } : p));
    // "now guards" in a move's note is the board after the move: "your queen on d1 now attacks the knight".
    const at = note.move && /\bnow\b/i.test(m[0]) ? sentence.after : positions;
    add('guards', m[0], at.map((fen) => {
      let ambiguous = false;
      for (const piece of by) for (const target of to) {
        const problem = guardProblem(fen, piece, verb, target, only && by.length === 1);
        if (problem === AMBIGUOUS) ambiguous = true;
        else if (problem) return problem;
      }
      return ambiguous ? AMBIGUOUS : undefined;
    }));
  };
  for (const m of text.matchAll(GUARDS)) claim(m, Boolean(m[1]), m[3] as string, m[2] as string, m[4] as string, (m.index ?? 0) + m[0].length);
  for (const m of text.matchAll(GUARDED_BY)) claim(m, false, ACTIVE[(m[2] as string).toLowerCase()] as string, m[3] as string, m[1] as string, (m.index ?? 0) + m[0].length);
  for (const m of text.matchAll(COMMA_GUARDED_BY)) claim(m, false, ACTIVE[(m[2] as string).toLowerCase()] as string, m[3] as string, m[1] as string, (m.index ?? 0) + m[0].length);
  if (note.move && moved) {
    const landed: Target = { piece: { side: moved.color, role: moved.role, square: note.move.uci.slice(2, 4) } };
    for (const m of text.matchAll(GUARDS_IT_THERE)) {
      const read = readSubjects((m[1] ?? m[3]) as string, note.you);
      if (!read) continue;
      const by = read.map((p) => (p.side || p.square ? p : { ...p, side: moved.color }));
      add('guards', m[0], sentence.after.map((fen) => {
        let ambiguous = false;
        for (const piece of by) {
          const problem = guardProblem(fen, piece, (m[2] ?? m[4]) as string, landed, false);
          if (problem === AMBIGUOUS) ambiguous = true;
          else if (problem) return problem;
        }
        return ambiguous ? AMBIGUOUS : undefined;
      }));
    }
  }
  for (const m of text.matchAll(NOTHING_GUARDS)) {
    const pieces = readPieces(m[1] as string, note.you);
    if (!pieces || pieces.length !== 1) continue;
    const piece = pieces[0] as Piece;
    add('guards', m[0], positions.map((fen) => {
      const at = find(fen, piece);
      if (at === AMBIGUOUS) return AMBIGUOUS;
      if (at === undefined) return `there is no ${describe(piece)}`;
      const side = positionFromFen(fen).board.get(at)?.color as Side;
      const by = defendersOf(fen, at, side);
      return by.length ? `${by.map(makeSquare).join(', ')} guard ${makeSquare(at)}` : undefined;
    }));
  }
  for (const m of text.matchAll(NO_PIECE_GUARDS)) {
    const side = (m[1] as string).toLowerCase() as Side;
    const targets = readTargets(m[2] as string, note.you);
    if (!targets) continue;
    add('guards', m[0], positions.map((fen) => {
      for (const target of targets) {
        const at = 'squares' in target ? target.squares.map((s) => parseSquare(s) as number) : [find(fen, target.piece)];
        for (const sq of at) {
          if (sq === AMBIGUOUS) return AMBIGUOUS;
          if (sq === undefined) return 'there is no such piece';
          const by = [...attackersOf(fen, sq, side)];
          if (by.length) return `${by.map(makeSquare).join(', ')} attack ${makeSquare(sq)}`;
        }
      }
      return undefined;
    }));
  }
}

function onlyMoveClaims(note: Note, sentence: Sentence, add: Add, holds: HoldClaim[]): void {
  const text = sentence.text;
  /** Whether the move from `fen` is the only legal one, as the Coach's facts say it. */
  const onlyLegal = (fen: string, uci: string) => moveFacts(fen, uci, []).some((f) => f.kind === 'only-move');
  const legalProblem = (ply: Ply | undefined, name: string): string | undefined =>
    !ply ? `${name} is not in the line` : onlyLegal(ply.fen, ply.uci) ? undefined : `${legalMoves(ply.fen).length} legal moves where ${ply.san} is played`;
  /** The first position of the line after the note's move where `side` is to move. */
  const turnAt = (side: Side): Ply | undefined => note.line.slice(note.move ? 1 : 0).find((x) => turnOf(x.fen) === side);
  /** The position the other side moves in after the note's move (the part's start, for a part's text). */
  const next = note.move ? { fen: note.move.fenAfter } : note.line[0];

  for (const m of text.matchAll(ONLY_LEGAL_SAN)) add('only-move', m[0], [legalProblem(plyOf(note, m[1] as string, m[0]), m[1] as string)]);
  for (const m of text.matchAll(LEAVES_ONLY)) add('only-move', m[0], [legalProblem(plyOf(note, m[1] as string, m[0]), m[1] as string)]);
  const it = ONLY_LEGAL_IT.exec(text);
  if (it && note.move) add('only-move', it[0], [legalProblem(note.move, note.move.san)]);
  for (const m of text.matchAll(SIDE_ONLY_MOVE)) {
    const side = (m[1] ?? m[2] as string).toLowerCase() as Side;
    add('only-move', m[0], [legalProblem(turnAt(side), `${side}'s move`)]);
  }
  for (const m of text.matchAll(PIECE_ONLY_MOVE)) {
    if (!next) continue;
    add('only-move', m[0], [squaresProblem(next.fen, (m[1] as string).toLowerCase() as Role, m[2] as string, false)]);
  }
  for (const m of text.matchAll(ITS_ONLY_TAKE)) {
    if (!next) continue;
    const pos = positionFromFen(next.fen);
    const role = (m[1] as string).toLowerCase() as Role;
    const targets = [...pos.board.pieces(other(pos.turn), role)];
    const forced = [...pos.board[pos.turn]].filter((s) => {
      const dests = [...pos.dests(s)];
      return dests.length === 1 && targets.includes(dests[0] as number);
    });
    add('only-move', m[0], [forced.length ? undefined : `no ${pos.turn} piece has taking the ${role} as its only move`]);
  }
  for (const pattern of ONLY_SQUARE) {
    for (const m of text.matchAll(pattern)) {
      const groups = m.slice(1).filter((g) => g !== undefined && g !== '');
      const square = groups.find((g) => /^[a-h][1-8]$/.test(g)) as string;
      const safe = groups.some((g) => /^safe ?$/i.test(g));
      const named = groups.find((g) => (ROLES as readonly string[]).includes(g.toLowerCase()))?.toLowerCase() as Role | undefined;
      // The note's own move going there is the piece the claim is about, in the position it moves from.
      if (note.move && note.move.uci.slice(2, 4) === square) {
        const pos = positionFromFen(note.move.fen);
        const role = pos.board.get(parseSquare(note.move.uci.slice(0, 2)) as number)?.role as Role;
        add('only-move', m[0], [squaresProblem(note.move.fen, role, square, safe, parseSquare(note.move.uci.slice(0, 2)))]);
        continue;
      }
      const role = named ?? (/\bking\b/i.test(text) ? 'king' : undefined);
      if (!role || !next) continue;
      add('only-move', m[0], [squaresProblem(next.fen, role, square, safe)]);
    }
  }
  for (const m of text.matchAll(SIDE_ONLY_DEFENCE)) {
    const ply = turnAt((m[1] as string).toLowerCase() as Side);
    if (ply && !onlyLegal(ply.fen, ply.uci)) holds.push({ at: note.at, phrase: m[0], fen: ply.fen, uci: ply.uci });
    else add('only-move', m[0], [legalProblem(ply, `${m[1]}'s move`)]);
  }
  for (const m of text.matchAll(HOLDS)) {
    const ply = m[1] ? plyOf(note, m[1], m[0]) : note.move;
    if (!ply) add('only-move', m[0], [`${m[1] ?? 'the move'} is not in the line`]);
    else holds.push({ at: note.at, phrase: m[0], fen: ply.fen, uci: ply.uci });
  }
  for (const m of text.matchAll(ANY_OTHER)) {
    if (!note.move) continue;
    // "Black has to take back with the king, because any other move allows mate": the reply's alternatives.
    const reply = new RegExp(String.raw`\b${other(note.you)} (?:has to|must)\b`, 'i').test(text.slice(0, m.index));
    const ply = reply ? note.line[1] : note.move;
    if (ply) holds.push({ at: note.at, phrase: m[0], fen: ply.fen, uci: ply.uci });
  }
}

/**
 * Why the side to move's `role` in `fen` (the one on `from`, or the only one) doesn't have `square`
 * as its only legal (and, with `safe`, unattacked) square, or undefined when it does.
 */
function squaresProblem(fen: string, role: Role, square: string, safe: boolean, from?: number): string | undefined {
  const pos = positionFromFen(fen);
  const all = from !== undefined ? [from] : [...pos.board.pieces(pos.turn, role)];
  if (all.length !== 1) return `${pos.turn} has ${all.length} ${role}s`;
  const at = all[0] as number;
  let dests = [...pos.dests(at)];
  if (safe) {
    dests = dests.filter((to) => {
      const next = pos.clone();
      next.play(moveTo(pos, at, to));
      return attackersOf(makeFen(next.toSetup()), to, other(pos.turn)).isEmpty();
    });
  }
  const names = dests.map(makeSquare);
  return names.length === 1 && names[0] === square ? undefined : `the ${role} can go${safe ? ' safely' : ''} to ${names.join(', ') || 'no square'}`;
}
