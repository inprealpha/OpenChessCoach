// The simple claims a Lesson's notes make about the board, read from a small set of phrasings and
// checked against the positions the note belongs to (issue #37). Most errors the chess review found
// were in notes, not moves: a material count, which piece guards a square, "the only move". This
// does not read free text in general. It matches the phrasings listed below, and a sentence that
// matches none of them is simply not checked.
//
// Covered phrasings (case-insensitive):
//
// Material, counted with the Coach's piece values (pawn 1, knight and bishop 3, rook 5, queen 9; the
// same as `materialBalance` in src/coach/explain.ts):
//   "<amount> up | down | ahead | behind", where <amount> is "a pawn", "two pawns", "a (whole) piece",
//   "a knight", "the exchange", "3 points", "a rook and two pawns", "a knight down for a pawn", or a
//   bare number of points ("now 3 ahead"). Whose count it is: the last "you", "White" or "Black"
//   before it in the note (not "White's" or "Black's"); "you" is the side the Player plays.
//   "the material is level | equal | even", "material stays level", "equal material".
//
// Guards, checked against the squares a piece attacks (chessops, as the Coach's facts):
//   "<piece> (and <piece>) [now|also|still|already|both|only] guards | defends | protects | covers |
//   attacks <target>, <target> and <target>", where <piece> names its square ("your rook on c1",
//   "the knight on f7", "Black's queen on c7") or is a side's king or only queen ("your king",
//   "White's queen"), and <target> is a square ("g8"), a piece on a square ("the bishop on e7"), a
//   side's king or only queen, or "the whole <nth> rank | <x>-file". A target given as a pronoun
//   ("guards it") is not checked. "Guards", "defends" and "protects" a piece mean one of the same
//   side's, and a piece pinned to its king guards no piece off its pin line, since it can't take
//   back (as `loosePieces` in explain.ts counts defenders); "attacks" a piece means one of the other
//   side's. A piece standing in the way blocks: a battery's back piece guards nothing past the front one.
//   "only <piece> guards <target>": as above, and no other piece of that side attacks the target.
//   "nothing guards | defends | protects <target piece>": no piece of its side attacks it.
//
// The only move, against the legal moves (the Coach's `only-move` fact):
//   "<move> is the only legal move", "It is the only legal move" (the note's move), a sentence that
//   starts "The only legal move" (the note's move), "leaves <move> as <side>'s only legal move",
//   "<side>'s only (legal) move is", "is <side>'s only (legal) move", "the king's only move is to <square>"
//   (the only legal move of the king of the side to move). A <move> may carry its number and a "!" or "?".
// The only move that doesn't lose, against the Engine (`noteClaims(…).holds`, checked by
// packages/backend/test/lesson-note-holds.test.ts):
//   "<move> | It is the only move that holds | draws | saves the game | doesn't lose";
//   "<side>'s only defence | answer | reply | way out (of check) is": the only legal move, or else the
//   only move that doesn't lose.
//
// Which positions a note's claim is about: a part's text, the positions from the part's start to its
// first decision. A node's note: a material count in the past ("you were …", "you started …"), the
// part's positions up to the node's; a guard, the node's own position and the ones after its move
// ("now guards", only those after); anything else, the positions after its move up to the next
// decision, or up to the last later move the sentence names. A sentence that starts "After <moves>"
// is about the position those moves lead to. A claim is true when it holds in one of its positions.
// Sentences with "if", "would" or "could" are about what might happen, so none of their claims are
// checked. Curly apostrophes count as straight ones.
import { attacks, between, ray } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';
import type { Role } from 'chessops/types';
import { makeSquare, parseSquare } from 'chessops/util';
import { legalMoves, playSan, playUci, positionFromFen, sansIn, turnOf, type Side } from '../src/chess.ts';
import { moveFacts } from '../src/coach/explain.ts';
import type { LessonData } from '../src/content/lessons.ts';

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
const HYPOTHETICAL = /\b(if|would|could)\b/i;

// --- The phrasings ---------------------------------------------------------------------------------

const NUM = String.raw`(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)`;
const UNIT = String.raw`(?:whole )?(?:pawns?|pieces?|knights?|bishops?|rooks?|queens?|points?)`;
const ITEM = String.raw`(?:${NUM} ${UNIT}|the exchange|an exchange)`;
const MATERIAL = new RegExp(String.raw`\b(${ITEM}(?: and ${ITEM})*|\d+) (up|down|ahead|behind)(?: for (${NUM} ${UNIT}))?\b`, 'gi');
const LEVEL = /\b(?:(?:the )?material (?:is|stays|remains) (?:now |still |again )?(?:level|equal|even)|(?:equal|level|even) material)\b/gi;

const SQ = '[a-h][1-8]';
const SIDE_WORD = String.raw`(?:your(?: own)?|black's(?: own)?|white's(?: own)?|the black|the white|the)`;
const ROLE = '(?:king|queen|rook|bishop|knight|pawn)';
/** A piece named by its square, or a side's king or queen. */
const PIECE = String.raw`(?:(?:${SIDE_WORD} )?${ROLE} on ${SQ}|(?:your|black's|white's) (?:king|queen))`;
const TARGET = String.raw`(?:${PIECE}|${SQ}\b|the whole (?:${ORDINALS.join('|')}) rank|the whole [a-h]-file)`;
const GUARD_VERB = '(?:guards?|defends?|protects?|covers?|attacks?)';
const ADVERBS = '(?:(?:now|also|still|already|both|only|then) )*';
const GUARDS = new RegExp(
  // A target followed by a verb is the next clause's subject ("attacks your queen, and the pawn on f5 attacks …").
  String.raw`(?<![\w'])(only )?(${PIECE}(?:,? and (?:${PIECE}|${ROLE} on ${SQ}))*) ${ADVERBS}(${GUARD_VERB}) (${TARGET}(?:(?:,| and|, and) ${TARGET}(?! ${ADVERBS}${GUARD_VERB}\b))*)`,
  'gi',
);
const NOTHING_GUARDS = new RegExp(String.raw`\bnothing (?:now )?(?:guards|defends|protects) (${PIECE})`, 'gi');

// A move as a note writes it, with or without its number and with any "!" or "?" after it: "85.Kg1", "8...Kd2", "Kg1!".
const SAN = String.raw`(?:\d+\.+ ?)?([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?[+#]?|O-O-O|O-O)[!?]*`;
const ONLY_LEGAL_SAN = new RegExp(String.raw`(?<![\w.])${SAN} is the only legal move\b`, 'g');
const ONLY_LEGAL_IT = /\b(?:it|this) is the only legal move\b|^the only legal move\b/i;
const LEAVES_ONLY = new RegExp(String.raw`\bleaves ${SAN} as (white|black)'s only legal move\b`, 'gi');
const SIDE_ONLY_MOVE = /\b(white|black)'s only (?:legal )?move is\b|\bis (white|black)'s only (?:legal )?move\b/gi;
const KING_ONLY_MOVE = /\bthe king's only move is to ([a-h][1-8])\b/gi;
const SIDE_ONLY_DEFENCE = /\b(white|black)'s only (?:defence|defense|answer|reply|way out(?: of (?:the )?check)?) is\b/gi;
const HOLDS = new RegExp(String.raw`(?:(?<![\w.])${SAN}|\b(it|this)) is the only move that (?:holds|draws|saves the game|does not lose|doesn't lose)\b`, 'gi');

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
  for (const text of note.text.split(/(?<=[;:])\s+|(?<=[.!?)])\s+(?=[A-Z0-9(])/)) {
    const sentence = reading(note, text, lead);
    lead += `${text} `;
    if (sentence) out.push(sentence);
  }
  return out;
}

function reading(note: Note, text: string, lead: string): Sentence | undefined {
  if (HYPOTHETICAL.test(text)) return undefined;
  const opening = AFTER_MOVES.exec(text);
  if (opening) {
    const fen = playedOn(note, sansIn(opening[0]));
    return fen ? { text, lead, after: [fen] } : undefined;
  }
  let reach = note.reach;
  for (const san of sansIn(text)) {
    const i = note.line.findIndex((x) => stripped(x.san) === stripped(san));
    if (i + 1 > reach) reach = i + 1;
  }
  return { text, lead, after: [...note.after, ...note.line.slice(note.reach, reach).map((x) => x.fenAfter)] };
}

/** A sentence of a note and the positions it may be about. */
interface Sentence {
  text: string;
  /** The note's text before it, where a count's subject may be: "You are White, 2 points behind: a knight down for a pawn." */
  lead: string;
  after: string[];
}

const AFTER_MOVES = new RegExp(String.raw`^After (?:\d+\.+ ?)?[KQRBNa-hO][\w+#=-]*(?: (?:\d+\.+ ?)?[KQRBNa-hO][\w+#=-]*)*`);

/** The position after `sans`, each one taken from the note's line where it is there and played on where it isn't. */
function playedOn(note: Note, sans: readonly string[]): string | undefined {
  let fen = note.after.at(-1) ?? note.before.at(-1);
  for (const san of sans) {
    const inLine = note.line.find((x) => stripped(x.san) === stripped(san));
    const next = inLine ? inLine.fenAfter : fen && playSan(fen, san)?.fenAfter;
    if (!next) return undefined;
    fen = next;
  }
  return fen;
}

const stripped = (san: string) => san.replace(/[+#!?]+$/, '');

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

/** Who a material count is about: the last "you", "White" or "Black" before it. */
function subjectBefore(text: string, you: Side): Side | undefined {
  const words = [...text.matchAll(/\b(you|white|black)\b(?!'s)/gi)];
  const last = words.at(-1)?.[1]?.toLowerCase();
  return last === undefined ? undefined : last === 'you' ? you : (last as Side);
}

/** Whether the count is told in the past: "you were …", "you started …", from the last verb after its subject. */
function pastBefore(text: string): boolean {
  const subject = [...text.matchAll(/\b(you|white|black)\b(?!'s)/gi)].at(-1)?.index ?? 0;
  const verbs = [...text.slice(subject).matchAll(/\b(are|is|stay|stays|remain|remains|were|was|started)\b/gi)];
  return /^(were|was|started)$/i.test(verbs.at(-1)?.[1] ?? '');
}

interface Piece {
  side?: Side;
  role: Role;
  /** Undefined for a king or queen named without a square: it is found on the board. */
  square?: string;
}

function sideOf(word: string | undefined, you: Side): Side | undefined {
  const w = word?.toLowerCase() ?? '';
  if (w.startsWith('your')) return you;
  if (w.startsWith('white') || w === 'the white') return 'white';
  if (w.startsWith('black') || w === 'the black') return 'black';
  return undefined;
}

/** "your rook on c1", "the knight on f7", "White's queen", "bishop on e7" (taking `inherit`'s side). */
function readPiece(phrase: string, you: Side, inherit?: Side): Piece | undefined {
  const m = new RegExp(String.raw`^(?:(${SIDE_WORD}) )?(${ROLE})(?: on (${SQ}))?$`, 'i').exec(phrase.trim());
  if (!m) return undefined;
  const side = m[1] ? sideOf(m[1], you) : inherit;
  return { ...(side ? { side } : {}), role: (m[2] as string).toLowerCase() as Role, ...(m[3] ? { square: m[3].toLowerCase() } : {}) };
}

/** Where `piece` stands in `fen`, or undefined when it isn't there (or, named without a square, isn't the only one). */
function find(fen: string, piece: Piece): number | undefined {
  const pos = positionFromFen(fen);
  if (piece.square) {
    const sq = parseSquare(piece.square) as number;
    const on = pos.board.get(sq);
    return on && on.role === piece.role && (!piece.side || on.color === piece.side) ? sq : undefined;
  }
  if (!piece.side) return undefined;
  const all = [...pos.board.pieces(piece.side, piece.role)];
  return all.length === 1 ? all[0] : undefined;
}

/** The squares the piece on `sq` attacks in `fen`. */
function attacked(fen: string, sq: number): SquareSet {
  const pos = positionFromFen(fen);
  const piece = pos.board.get(sq);
  return piece ? attacks(piece, sq, pos.board.occupied) : SquareSet.empty();
}

type Target = { piece: Piece } | { squares: string[]; name: string };

function readTarget(phrase: string, you: Side): Target | undefined {
  const t = phrase.trim().toLowerCase();
  if (/^[a-h][1-8]$/.test(t)) return { squares: [t], name: t };
  const rank = /^the whole (\w+) rank$/.exec(t);
  if (rank) {
    const r = ORDINALS.indexOf(rank[1] as string) + 1;
    return { squares: 'abcdefgh'.split('').map((f) => `${f}${r}`), name: t };
  }
  const file = /^the whole ([a-h])-file$/.exec(t);
  if (file) return { squares: [1, 2, 3, 4, 5, 6, 7, 8].map((r) => `${file[1]}${r}`), name: t };
  const piece = readPiece(t, you);
  return piece ? { piece } : undefined;
}

/** Why `by` doesn't `verb` `target` in `fen`, or undefined when it does. */
function guardProblem(fen: string, by: Piece, verb: string, target: Target, only: boolean): string | undefined {
  const from = find(fen, by);
  if (from === undefined) return `there is no ${describe(by)}`;
  const side = positionFromFen(fen).board.get(from)?.color as Side;
  const hits = attacked(fen, from);
  let squares: number[];
  if ('squares' in target) {
    squares = target.squares.map((s) => parseSquare(s) as number).filter((s) => s !== from);
    const missed = squares.filter((s) => !hits.has(s));
    if (missed.length) return `the ${describe(by)} does not reach ${missed.map(makeSquare).join(', ')}`;
  } else {
    const at = find(fen, target.piece);
    if (at === undefined) return `there is no ${describe(target.piece)}`;
    const targetSide = positionFromFen(fen).board.get(at)?.color as Side;
    if (/^(guard|defend|protect)/i.test(verb) && targetSide !== side) return `the ${describe(target.piece)} is not ${side}'s`;
    if (/^attack/i.test(verb) && targetSide === side) return `the ${describe(target.piece)} is ${side}'s own`;
    if (!hits.has(at)) return `the ${describe(by)} does not attack ${makeSquare(at)}`;
    // A pinned piece can't take back, so it guards nothing off its pin line: the Coach's facts count
    // a defender the same way (`loosePieces` in explain.ts).
    const pin = pinLine(fen, from, side);
    if (targetSide === side && pin && !pin.has(at)) return `the ${describe(by)} is pinned to its king and cannot take back on ${makeSquare(at)}`;
    squares = [at];
  }
  if (only) {
    for (const sq of squares) {
      const others = [...attackersOf(fen, sq, side)].filter((s) => s !== from);
      if (others.length) return `${others.map(makeSquare).join(', ')} also guard ${makeSquare(sq)}`;
    }
  }
  return undefined;
}

/** The line `side`'s piece on `from` is pinned along to its king, or undefined when it isn't pinned. */
function pinLine(fen: string, from: number, side: Side): SquareSet | undefined {
  const pos = positionFromFen(fen);
  const king = pos.board.kingOf(side);
  if (king === undefined || king === from) return undefined;
  const open = pos.board.occupied.without(from);
  for (const s of pos.board[side === 'white' ? 'black' : 'white']) {
    const piece = pos.board.get(s);
    if (!piece || !['bishop', 'rook', 'queen'].includes(piece.role)) continue;
    if (between(king, s).has(from) && attacks(piece, s, open).has(king)) return ray(king, s);
  }
  return undefined;
}

/** The squares of `side`'s pieces that attack `sq`. */
function attackersOf(fen: string, sq: number, side: Side): SquareSet {
  const pos = positionFromFen(fen);
  let out = SquareSet.empty();
  for (const s of pos.board[side]) if (attacks(pos.board.get(s) as { role: Role; color: Side }, s, pos.board.occupied).has(sq)) out = out.with(s);
  return out;
}

function describe(p: Piece): string {
  return `${p.side ? `${p.side} ` : ''}${p.role}${p.square ? ` on ${p.square}` : ''}`;
}

/** The ply of the note's line that plays `san`, as the Player would read it. */
function plyOf(note: Note, san: string): Ply | undefined {
  return note.line.find((x) => stripped(x.san) === stripped(san));
}

// --- Checking --------------------------------------------------------------------------------------

/** Every claim in a Lesson's notes that the phrasings cover, each checked on the board. */
export function noteClaims(lesson: LessonData): { claims: NoteClaim[]; holds: HoldClaim[] } {
  const claims: NoteClaim[] = [];
  const holds: HoldClaim[] = [];
  for (const note of notesOf(lesson)) {
    for (const sentence of sentencesOf(note)) {
      const add = (kind: ClaimKind, phrase: string, problem: string | undefined) =>
        claims.push({ kind, at: note.at, phrase, ...(problem ? { problem } : {}) });
      const anyHolds = (positions: string[], problemIn: (fen: string) => string | undefined): string | undefined => {
        const problems = positions.map(problemIn);
        return problems.some((x) => x === undefined) ? undefined : problems[problems.length - 1];
      };
      materialClaims(note, sentence, add, anyHolds);
      guardClaims(note, sentence, add, anyHolds);
      onlyMoveClaims(note, sentence, add, holds);
    }
  }
  return { claims, holds };
}

type Add = (kind: ClaimKind, phrase: string, problem: string | undefined) => void;
type AnyHolds = (positions: string[], problemIn: (fen: string) => string | undefined) => string | undefined;

function materialClaims(note: Note, sentence: Sentence, add: Add, anyHolds: AnyHolds): void {
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
    add('material', m[0], anyHolds(positions, (fen) => {
      const have = materialBalance(fen, side);
      return have === want ? undefined : `${side} is ${have > 0 ? `${have} up` : have < 0 ? `${-have} down` : 'level'}, not ${want > 0 ? `${want} up` : `${-want} down`}`;
    }));
  }
  for (const m of sentence.text.matchAll(LEVEL)) {
    add('material', m[0], anyHolds(sentence.after, (fen) => {
      const have = materialBalance(fen, 'white');
      return have === 0 ? undefined : `White is ${have > 0 ? `${have} up` : `${-have} down`}, not level`;
    }));
  }
}

function guardClaims(note: Note, sentence: Sentence, add: Add, anyHolds: AnyHolds): void {
  // The note's own position and the ones after its move: a guard is about the board as it is now.
  const positions = [...note.before.slice(-1), ...sentence.after];
  for (const m of sentence.text.matchAll(GUARDS)) {
    const only = Boolean(m[1]);
    const verb = m[3] as string;
    const subjects: Piece[] = [];
    for (const phrase of (m[2] as string).split(/,? and /)) {
      const piece = readPiece(phrase, note.you, subjects[0]?.side);
      if (piece) subjects.push(piece);
    }
    const targets = (m[4] as string).split(/, and |,| and /).map((t) => readTarget(t, note.you));
    if (!subjects.length || targets.some((t) => !t)) continue;
    // "now guards" in a move's note is the board after the move: "your queen on d1 now attacks the knight".
    const at = note.move && /\bnow\b/i.test(m[0]) ? sentence.after : positions;
    add('guards', m[0], anyHolds(at, (fen) => {
      for (const by of subjects) for (const target of targets) {
        const problem = guardProblem(fen, by, verb, target as Target, only && subjects.length === 1);
        if (problem) return problem;
      }
      return undefined;
    }));
  }
  for (const m of sentence.text.matchAll(NOTHING_GUARDS)) {
    const piece = readPiece(m[1] as string, note.you);
    if (!piece) continue;
    add('guards', m[0], anyHolds(positions, (fen) => {
      const at = find(fen, piece);
      if (at === undefined) return `there is no ${describe(piece)}`;
      const side = positionFromFen(fen).board.get(at)?.color as Side;
      const by = [...attackersOf(fen, at, side)];
      return by.length ? `${by.map(makeSquare).join(', ')} guard ${makeSquare(at)}` : undefined;
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

  for (const m of text.matchAll(ONLY_LEGAL_SAN)) add('only-move', m[0], legalProblem(plyOf(note, m[1] as string), m[1] as string));
  for (const m of text.matchAll(LEAVES_ONLY)) add('only-move', m[0], legalProblem(plyOf(note, m[1] as string), m[1] as string));
  const it = ONLY_LEGAL_IT.exec(text);
  if (it && note.move) add('only-move', it[0], legalProblem(note.move, note.move.san));
  for (const m of text.matchAll(SIDE_ONLY_MOVE)) {
    const side = (m[1] ?? m[2] as string).toLowerCase() as Side;
    add('only-move', m[0], legalProblem(turnAt(side), `${side}'s move`));
  }
  for (const m of text.matchAll(KING_ONLY_MOVE)) {
    const ply = note.line[note.move ? 1 : 0];
    if (!ply) continue;
    const pos = positionFromFen(ply.fen);
    const king = pos.board.kingOf(pos.turn) as number;
    const dests = [...(pos.dests(king) ?? SquareSet.empty())].map(makeSquare);
    add('only-move', m[0], dests.length === 1 && dests[0] === m[1] ? undefined : `the king can go to ${dests.join(', ') || 'no square'}`);
  }
  for (const m of text.matchAll(SIDE_ONLY_DEFENCE)) {
    const ply = turnAt((m[1] as string).toLowerCase() as Side);
    if (ply && !onlyLegal(ply.fen, ply.uci)) holds.push({ at: note.at, phrase: m[0], fen: ply.fen, uci: ply.uci });
    else add('only-move', m[0], legalProblem(ply, `${m[1]}'s move`));
  }
  for (const m of text.matchAll(HOLDS)) {
    const ply = m[1] ? plyOf(note, m[1]) : note.move;
    if (!ply) add('only-move', m[0], `${m[1] ?? 'the move'} is not in the line`);
    else holds.push({ at: note.at, phrase: m[0], fen: ply.fen, uci: ply.uci });
  }
}
