// The explainability layer between the Engine and the Coach. A raw Engine line shows best play
// from both sides and hides the why: what a move takes or attacks, what it leaves to be taken, and
// what its line wins or loses. This reads those facts off the board and the Engine's own lines, so
// the Coach explains them instead of working them out from a string of moves (ADR 0002, ADR 0009).
// Every fact is the board as it stands or what happens in an Engine line, and one that could be
// beside the point (a piece that can be taken, an attack) is kept only when the line takes that
// piece: a wrong or idle fact is worse than none, because the Coach repeats it. Each fact names its
// pieces and squares, so it can be drawn as well as said.
import { attacks, kingAttacks, ray } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';
import type { Role } from 'chessops/types';
import { makeSquare, parseSquare } from 'chessops/util';
import { isCheck, legalMoves, otherSide, playUci, positionFromFen, SIDE_NAMES, type Side } from '../chess.ts';
import type { Score } from '../engine.ts';
import { nullMoveFen } from '../threat.ts';

type Position = ReturnType<typeof positionFromFen>;

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
/** The longest forcing sequence counted in a line, in plies. */
const COUNTED_PLIES = 10;
/** How soon a line must take a piece to confirm it can be taken, in plies. */
const CONFIRM_PLIES = 6;
/** How far past the counted moves the line is counted again, to check the count stands, in plies. */
const SETTLE_PLIES = 10;
/** Material swings smaller than this, in pawns, are left unsaid: a pawn here or there is where Engine lines are least reliable. */
const MIN_GAIN = 2;
/** How far, in pawns, the Engine's score must lean the count's way, beyond the material already on the board. */
const AGREEMENT = 1.5;
const PROMOTIONS: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
const HOME: Record<string, Role> = { b1: 'knight', g1: 'knight', c1: 'bishop', f1: 'bishop', b8: 'knight', g8: 'knight', c8: 'bishop', f8: 'bishop' };
const NUMBERS = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

/** A piece and the square it stands on. */
export interface PieceAt {
  side: Side;
  role: Role;
  square: string;
}

/** One move of an Engine line, as the board shows it. */
export interface LinePly {
  uci: string;
  san: string;
  side: Side;
  role: Role;
  from: string;
  to: string;
  captured?: Role;
  promotion?: Role;
  fenAfter: string;
}

/** Plays a line of UCI moves from `fen`, stopping at the first illegal one. */
export function readLine(fen: string, ucis: readonly string[]): LinePly[] {
  const out: LinePly[] = [];
  let current = fen;
  for (const uci of ucis) {
    const played = playUci(current, uci);
    if (!played) break;
    const board = positionFromFen(current).board;
    const from = parseSquare(played.uci.slice(0, 2)) as number;
    const to = parseSquare(played.uci.slice(2, 4)) as number;
    const mover = board.get(from);
    if (!mover) break;
    const target = board.get(to);
    // En passant: a pawn moving sideways onto an empty square takes a pawn.
    const enPassant = mover.role === 'pawn' && !target && from % 8 !== to % 8;
    const captured = target && target.color !== mover.color ? target.role : enPassant ? 'pawn' : undefined;
    const promotion = PROMOTIONS[played.uci[4] ?? ''];
    out.push({
      uci: played.uci,
      san: played.san,
      side: mover.color,
      role: mover.role,
      from: makeSquare(from),
      to: makeSquare(to),
      ...(captured ? { captured } : {}),
      ...(promotion ? { promotion } : {}),
      fenAfter: played.fenAfter,
    });
    current = played.fenAfter;
  }
  return out;
}

const forcing = (p: LinePly) => Boolean(p.captured || p.promotion || /[+#]$/.test(p.san));

/**
 * The plies of a line whose material counts: its first move and the forcing sequence right after
 * it (captures, promotions, checks and answers to a check), up to the first quiet move. Further on,
 * the Engine's line is a guess at best play. A line that ends while taking, with a piece that can
 * be taken back, ends in the middle of an exchange, so that whole exchange is left out.
 */
function counted(plies: readonly LinePly[]): readonly LinePly[] {
  let end = Math.min(1, plies.length);
  while (end < Math.min(plies.length, COUNTED_PLIES) && (forcing(plies[end] as LinePly) || /[+#]$/.test(plies[end - 1]?.san ?? ''))) end++;
  const last = plies[end - 1];
  if (end === plies.length && last?.captured && loosePieces(last.fenAfter).some((l) => l.piece.square === last.to)) {
    while (end > 0 && plies[end - 1]?.captured) end--;
  }
  return plies.slice(0, end);
}

/** What a line leads to for one side, counted in material over the forcing sequence after its first move (see `counted`). */
export interface LineOutcome {
  side: Side;
  /** What each side takes, with equal values cancelled (a knight for a bishop is a trade). */
  gains: Role[];
  losses: Role[];
  /** Material gained by `side`, in pawns: Infinity for a mate by `side`, -Infinity against it. */
  gain: number;
  /** False when counting further into the line changes the count by a piece's worth or more. */
  settled: boolean;
  /** The moves the outcome is read from, so it is plain when it happens. */
  line: string[];
  /**
   * A mate in `in` moves of the mating side, in the line or beyond it as the score shows. For a mate
   * the line shows with every reply forced, so its end is the only one: the mated king's own pieces
   * that block it in, and the pieces that protect the one giving mate when it stands next to the king.
   */
  mate?: { by: Side; in: number; boxedBy?: PieceAt[]; giver?: PieceAt; guardedBy?: PieceAt[] };
}

/**
 * What a line leads to for `side`: the material each side takes, or a mate. `score` is the Engine's
 * score at the line's start from `side`'s point of view, for a mate the line is too short to show.
 */
export function lineOutcome(side: Side, plies: readonly LinePly[], score?: Score): LineOutcome {
  const base = { side, gains: [], losses: [], settled: true, line: [] };
  const last = plies.at(-1);
  if (last?.san.endsWith('#')) {
    const mate = { by: last.side, in: plies.filter((p) => p.side === last.side).length };
    // With a choice of replies on the way, the mating position is one of several: its details are not said.
    const forced = plies.every((p, i) => i === 0 || p.side === last.side || legalMoves((plies[i - 1] as LinePly).fenAfter).length === 1);
    const giver: PieceAt = { side: last.side, role: last.promotion ?? last.role, square: last.to };
    const details = forced ? { boxedBy: ownNeighbours(last.fenAfter, otherSide(last.side)), giver, guardedBy: guardsOfGiver(last.fenAfter, giver) } : {};
    return { ...base, line: plies.map((p) => p.san), mate: { ...mate, ...details }, gain: last.side === side ? Infinity : -Infinity };
  }
  if (score?.mate !== undefined && score.mate !== 0) {
    const by = score.mate > 0 ? side : otherSide(side);
    return { ...base, mate: { by, in: Math.abs(score.mate) }, gain: by === side ? Infinity : -Infinity };
  }
  const line = counted(plies);
  const now = tally(side, line);
  // A count the next moves undo (a knight trapped in the corner where it took a rook) is not the end
  // of it. Counted again up to the last quiet moment a little further on, the line can only silence
  // the count, never make one: deep in a line the Engine's moves are a guess.
  let end = line.length;
  for (let e = line.length + 2; e <= Math.min(plies.length, line.length + SETTLE_PLIES); e++) {
    if (!forcing(plies[e - 2] as LinePly) && !forcing(plies[e - 1] as LinePly)) end = e;
  }
  return { ...base, ...now, line: line.map((p) => p.san), settled: Math.abs(tally(side, plies.slice(0, end)).gain - now.gain) < MIN_GAIN };
}

/** What each side takes in `line`, for `side`: equal values cancel, and a promotion turns a pawn into the new piece. */
function tally(side: Side, line: readonly LinePly[]): Pick<LineOutcome, 'gains' | 'losses' | 'gain'> {
  const won = (by: Side) => line.flatMap((p) => (p.side === by ? [p.captured, p.promotion].filter((r): r is Role => r !== undefined) : []));
  const promoted = (by: Side) => line.filter((p) => p.side === by && p.promotion).map((): Role => 'pawn');
  const gains = [...won(side), ...promoted(otherSide(side))];
  const losses = [...won(otherSide(side)), ...promoted(side)];
  for (const g of [...gains]) {
    const i = losses.findIndex((l) => VALUE[l] === VALUE[g]);
    if (i >= 0) {
      losses.splice(i, 1);
      gains.splice(gains.indexOf(g), 1);
    }
  }
  return { gains, losses, gain: sum(gains) - sum(losses) };
}

/**
 * Whether a line's outcome is worth telling the Coach: a mate, or at least a piece's worth of
 * material that stands and that the Engine's score agrees with (ADR 0009). `fen` is where the line
 * starts and `score` the Engine's score of it, from `o.side`'s point of view. Scores grow slower than
 * material, so the score need only lean the same way beyond the material already on the board.
 */
export function worthSaying(o: LineOutcome, fen: string, score: Score): boolean {
  if (o.mate) return score.mate !== undefined && score.mate !== 0 && score.mate > 0 === (o.mate.by === o.side);
  if (Math.abs(o.gain) < MIN_GAIN || !o.settled) return false;
  if (score.mate !== undefined) return o.gain > 0 === score.mate > 0;
  const lean = Math.max(-12, Math.min(12, score.cp / 100)) - materialBalance(fen, o.side);
  return Math.sign(lean) === Math.sign(o.gain) && Math.abs(lean) >= Math.max(AGREEMENT, 0.4 * Math.abs(o.gain));
}

/** `side`'s material minus the other side's, in pawns. */
function materialBalance(fen: string, side: Side): number {
  let total = 0;
  for (const [, piece] of positionFromFen(fen).board) total += piece.color === side ? VALUE[piece.role] : -VALUE[piece.role];
  return total;
}

/** "White wins a knight", "Black gives up a rook for a knight", "White mates in 2 (…)". */
export function describeOutcome(o: LineOutcome): string {
  // The moves it happens over, so a loss a few moves on isn't read as the move's own.
  const over = o.line.length > 1 ? ` (${o.line.join(' ')})` : '';
  if (o.mate) {
    const { by, boxedBy = [], giver, guardedBy = [] } = o.mate;
    // A mate in one is one event, the move itself or the very next one, never a capture and then a mate.
    const parts = [`${o.mate.in > 1 ? `${SIDE_NAMES[by]} mates in ${o.mate.in}` : by === o.side ? 'it is checkmate' : `${SIDE_NAMES[by]}'s next move is checkmate`}${over}`];
    if (boxedBy.length) parts.push(`at the end, ${SIDE_NAMES[otherSide(by)]}'s own ${pieceList(boxedBy)} ${boxedBy.length > 1 ? 'block' : 'blocks'} its king in`);
    if (giver && guardedBy.length) parts.push(`the ${giver.role} giving mate on ${giver.square} is protected by ${list(guardedBy.map(named))}`);
    return parts.join('; ');
  }
  const name = SIDE_NAMES[o.side];
  const { gains, losses } = o;
  if (!gains.length && !losses.length) return `material stays level${over}`;
  if (!losses.length) return `${name} wins ${pieces(gains)}${over}`;
  if (!gains.length) return `${name} loses ${pieces(losses)}${over}`;
  return `${o.gain >= 0 ? `${name} wins ${pieces(gains)} for ${pieces(losses)}` : `${name} gives up ${pieces(losses)} for ${pieces(gains)}`}${over}`;
}

/** A piece that the other side could take now and come out ahead: nothing defends it, or a cheaper piece attacks it. */
export interface LoosePiece {
  piece: PieceAt;
  /** The cheapest piece that can take it. */
  attacker: PieceAt;
  defended: boolean;
}

/** Every piece in `fen` that the other side could take now and come out ahead, counting only legal captures. */
export function loosePieces(fen: string): LoosePiece[] {
  const pos = positionFromFen(fen);
  const passed = nullMoveFen(fen);
  // Captures are legal or not for the side that would make them; with the side to move in check
  // there is no position where the other side moves, and every attack counts.
  const capturer = (side: Side) => (side === pos.turn ? pos : passed ? positionFromFen(passed) : undefined);
  const out: LoosePiece[] = [];
  for (const [sq, piece] of pos.board) {
    if (piece.role === 'king') continue;
    const enemy = otherSide(piece.color);
    const mover = capturer(enemy);
    const takers = mover ? legalTakers(mover, sq) : [...pos.kingAttackers(sq, enemy, pos.board.occupied)];
    const cheapest = takers.sort((a, b) => rank(pos.board.get(a)?.role) - rank(pos.board.get(b)?.role))[0];
    const role = cheapest === undefined ? undefined : pos.board.get(cheapest)?.role;
    if (cheapest === undefined || !role) continue;
    // Defended means it can be taken back, legally: not by a pinned piece, nor by a king the taker is protected against.
    const defended = mover ? legalTakers(played(mover, cheapest, sq), sq).length > 0 : pos.kingAttackers(sq, piece.color, pos.board.occupied).nonEmpty();
    if (role === 'king' ? defended : defended && VALUE[role] >= VALUE[piece.role]) continue;
    out.push({ piece: { side: piece.color, role: piece.role, square: makeSquare(sq) }, attacker: { side: enemy, role, square: makeSquare(cheapest) }, defended });
  }
  return out;
}

/** The squares of the pieces of the side to move in `pos` that can legally take on `square`. */
function legalTakers(pos: Position, square: number): number[] {
  return [...pos.kingAttackers(square, pos.turn, pos.board.occupied)].filter((from) => pos.isLegal(capture(pos, from, square)));
}

/** `pos` after the piece on `from` takes on `square`. */
function played(pos: Position, from: number, square: number): Position {
  const next = pos.clone();
  next.play(capture(pos, from, square));
  return next;
}

/** A move onto `to`, promoting to a queen if it is a pawn reaching the last rank. */
function capture(pos: Position, from: number, to: number) {
  const promotes = pos.board.get(from)?.role === 'pawn' && (to >> 3 === 0 || to >> 3 === 7);
  return { from, to, ...(promotes ? { promotion: 'queen' as const } : {}) };
}

/** Whether `line` takes the piece standing on `square` at its start, there, within `limit` plies, before it moves. */
function takenThere(line: readonly LinePly[], square: string, limit: number): boolean {
  for (const p of line.slice(0, limit)) {
    if (p.to === square && p.captured) return true;
    if (p.from === square) return false;
  }
  return false;
}

/** The squares where the piece standing on `square` at the line's start takes something, following it as it moves, until it is taken. */
function takesOn(line: readonly LinePly[], square: string, limit: number): string[] {
  let at = square;
  const out: string[] = [];
  for (const p of line.slice(0, limit)) {
    if (p.from === at) {
      if (p.captured) out.push(p.to);
      at = p.to;
    } else if (p.to === at) break;
  }
  return out;
}

/** One fact about a move, naming the pieces and squares involved. */
export type MoveFact =
  | { kind: 'takes'; piece: PieceAt }
  | { kind: 'castles'; wing: 'king' | 'queen' }
  | { kind: 'promotes'; role: Role }
  | { kind: 'check' }
  | { kind: 'checkmate' }
  | { kind: 'develops'; piece: PieceAt }
  | { kind: 'only-move' }
  /** The moved piece attacks two or more pieces at once (the king counting, when it gives check) and goes on to take one. */
  | { kind: 'double-attack'; by: PieceAt; targets: PieceAt[] }
  /** Pieces that can be taken now and couldn't before, by the moved piece or one it uncovered, which the line takes. */
  | { kind: 'attacks'; targets: LoosePiece[] }
  /** One of the mover's pieces that can be taken after the move, and the line takes; `moved` when it is the moved piece, `wasLoose` when it could be taken before too. */
  | { kind: 'leaves'; loose: LoosePiece; moved: boolean; wasLoose: boolean }
  /** A check along a line with `behind` beyond the king on it, which the checking piece goes on to take. */
  | { kind: 'skewer'; king: PieceAt; behind: PieceAt }
  /** The moved piece guarded `square` and no longer does, and the reply goes there and uses it. */
  | { kind: 'stops-guarding'; square: string; next: PieceAt }
  /** Pieces that attack the moved piece but can't take it, because `by` pins them to their own king. */
  | { kind: 'pinned-attackers'; pins: { piece: PieceAt; by: PieceAt }[] }
  | { kind: 'gives-up-castling'; wings: ('king' | 'queen')[] }
  /** The king's move leaves these of its own pieces no squares to go to. */
  | { kind: 'blocks'; pieces: PieceAt[] };

/**
 * What a move does on the board. `line` is the Engine's line after the move, starting with the
 * reply: a piece that can be taken is mentioned only when that line soon takes it where it stands.
 */
export function moveFacts(fen: string, uci: string, line: readonly string[]): MoveFact[] {
  const [move] = readLine(fen, [uci]);
  if (!move) return [];
  const after = move.fenAfter;
  const rest = readLine(after, line);
  const taken = (square: string) => takenThere(rest, square, CONFIRM_PLIES);
  return [...ownFacts(fen, move), ...attackFacts(fen, move, rest, taken), ...exposureFacts(fen, move, rest, taken)];
}

/** What the move itself is: the only move, a capture, castling, a promotion, a check, development, a king walk. */
function ownFacts(fen: string, move: LinePly): MoveFact[] {
  const facts: MoveFact[] = [];
  if (legalMoves(fen).length === 1) facts.push({ kind: 'only-move' });
  if (move.san.startsWith('O-O')) facts.push({ kind: 'castles', wing: move.san.startsWith('O-O-O') ? 'queen' : 'king' });
  else if (move.captured) facts.push({ kind: 'takes', piece: { side: otherSide(move.side), role: move.captured, square: move.to } });
  if (move.promotion) facts.push({ kind: 'promotes', role: move.promotion });
  if (move.san.endsWith('#')) facts.push({ kind: 'checkmate' });
  else if (move.san.endsWith('+')) facts.push({ kind: 'check' });
  if (HOME[move.from] === move.role && move.from[1] === (move.side === 'white' ? '1' : '8')) facts.push({ kind: 'develops', piece: { side: move.side, role: move.role, square: move.to } });
  // A king walk is what costs castling worth a word, and what can box in its own pieces; a king
  // forced out of check had no choice.
  if (move.role === 'king' && !move.san.startsWith('O-O') && !isCheck(fen)) {
    const castling = castlingLost(fen, move.fenAfter, move.side);
    if (castling.length) facts.push({ kind: 'gives-up-castling', wings: castling });
    const blocked = blockedByKing(fen, move);
    if (blocked.length) facts.push({ kind: 'blocks', pieces: blocked });
  }
  return facts;
}

/** What the move attacks: a double attack or a skewer the moved piece goes on to win, or pieces it uncovered an attack on. */
function attackFacts(fen: string, move: LinePly, rest: readonly LinePly[], taken: (square: string) => boolean): MoveFact[] {
  const board = positionFromFen(fen).board;
  const before = loosePieces(fen);
  // Pieces that can be taken now and couldn't before, unless by the same piece that already attacked
  // them: then the move only took away a defender, and that is not an attack it made.
  const attacked = loosePieces(move.fenAfter).filter((l) => {
    if (l.piece.side === move.side || before.some((b) => b.piece.square === l.piece.square && b.piece.role === l.piece.role)) return false;
    if (l.attacker.square === move.to) return true;
    const from = parseSquare(l.attacker.square) as number;
    const old = board.get(from);
    return !(old?.role === l.attacker.role && attacks(old, from, board.occupied).has(parseSquare(l.piece.square) as number));
  });
  const facts: MoveFact[] = [];
  const ownTakes = takesOn(rest, move.to, CONFIRM_PLIES);
  const check = /[+#]$/.test(move.san);
  if (attacked.some((l) => taken(l.piece.square))) {
    const king = check ? checkedKing(move) : undefined;
    const byMoved = attacked.filter((l) => l.attacker.square === move.to);
    const double = byMoved.length + (king ? 1 : 0) > 1 && byMoved.some((l) => ownTakes.includes(l.piece.square));
    if (double) facts.push({ kind: 'double-attack', by: { side: move.side, role: move.role, square: move.to }, targets: [...(king ? [king] : []), ...byMoved.map((l) => l.piece)] });
    const others = (double ? attacked.filter((l) => l.attacker.square !== move.to) : attacked).filter((l) => taken(l.piece.square));
    if (others.length) facts.push({ kind: 'attacks', targets: others });
  }
  const behind = check ? behindKing(move) : undefined;
  if (behind && ownTakes.includes(behind.behind.square)) facts.push({ kind: 'skewer', ...behind });
  return facts;
}

/** What the move exposes: its own pieces left to be taken, a square it stops guarding, and a pin that saves it. */
function exposureFacts(fen: string, move: LinePly, rest: readonly LinePly[], taken: (square: string) => boolean): MoveFact[] {
  const after = move.fenAfter;
  const before = loosePieces(fen);
  const facts: MoveFact[] = [];
  for (const l of loosePieces(after).filter((x) => x.piece.side === move.side && taken(x.piece.square))) {
    const moved = l.piece.square === move.to;
    // Taking a piece worth as much or more is a trade, even when the taker can be taken back.
    if (moved && move.captured && VALUE[move.captured] >= VALUE[move.role]) continue;
    const square = moved ? move.from : l.piece.square;
    facts.push({ kind: 'leaves', loose: l, moved, wasLoose: before.some((b) => b.piece.square === square && b.piece.side === move.side) });
  }
  // A square the moved piece guarded and no longer does, which the reply goes to and uses: it takes
  // or checks there, or takes from there later in the line. Not when a king steps in, nor when
  // another piece still guards it, nor when the reply just takes a piece already said to be left.
  const reply = rest[0];
  if (reply && reply.role !== 'king' && reply.to !== move.to && !facts.some((f) => f.kind === 'leaves' && f.loose.piece.square === reply.to)) {
    const uses = forcing(reply) || takesOn(rest.slice(1), reply.to, CONFIRM_PLIES).length > 0;
    const square = parseSquare(reply.to) as number;
    const lost = guards(fen, move.from).has(square) && !guards(after, move.to).has(square);
    if (uses && lost && legalTakers(positionFromFen(reply.fenAfter), square).length === 0) {
      facts.push({ kind: 'stops-guarding', square: reply.to, next: { side: reply.side, role: reply.role, square: reply.to } });
    }
  }
  // Only when nothing else can take it either, and the line doesn't: otherwise the pin is beside the point.
  const to = parseSquare(move.to) as number;
  const pinned = pinnedAttackers(move);
  if (pinned.length && legalTakers(positionFromFen(after), to).length === 0 && !taken(move.to)) facts.push({ kind: 'pinned-attackers', pins: pinned });
  return facts;
}

/** A move fact in plain words, as the brief gives it to the Coach. Every piece but the moved one is named with its side. */
export function describeFact(f: MoveFact): string {
  switch (f.kind) {
    case 'takes':
      return `takes ${named(f.piece)}`;
    case 'castles':
      return f.wing === 'king' ? 'castles' : 'castles on the queen side';
    case 'promotes':
      return `promotes to a ${f.role}`;
    case 'check':
      return 'gives check';
    case 'checkmate':
      return 'gives checkmate';
    case 'develops':
      return `brings the ${f.piece.role} out from its starting square`;
    case 'only-move':
      return 'is the only legal move';
    case 'double-attack':
      return `attacks ${NUMBERS[f.targets.length] ?? f.targets.length} pieces at once: ${list(f.targets.map(named))}`;
    case 'attacks':
      return f.targets.map((t) => `now ${named(t.attacker)} attacks ${named(t.piece)}${t.defended ? '' : ', which nothing defends'}`).join('; ');
    case 'leaves': {
      const { piece, attacker, defended } = f.loose;
      // Whether taking it pays is the line's result to say: a piece can be offered on purpose.
      const takes = `where ${named(attacker)} can take it${defended ? '' : ' and nothing defends it'}`;
      if (!f.moved) return `leaves ${named(piece)} ${takes}`;
      return f.wasLoose ? `moves the attacked ${piece.role} to ${piece.square}, ${takes}` : `puts the ${piece.role} on ${piece.square}, ${takes}`;
    }
    case 'skewer':
      return `once ${named(f.king)} steps out of the check, ${named(f.behind)} behind it on the same line can be taken`;
    case 'stops-guarding':
      return `stops guarding ${f.square}, the square ${SIDE_NAMES[f.next.side]}'s ${f.next.role} goes to next`;
    case 'pinned-attackers':
      return `can't be taken by ${list(f.pins.map((p) => `${named(p.piece)}, which ${named(p.by)} pins to its own king`))}`;
    case 'gives-up-castling':
      return f.wings.length > 1 ? 'gives up the right to castle' : `gives up castling on the ${f.wings[0]} side`;
    case 'blocks':
      return `blocks ${list(f.pieces.map(named))}, leaving ${f.pieces.length > 1 ? 'them' : 'it'} no squares to go to`;
  }
}

/** For a check by a long-range moved piece, the king and the first piece of its side beyond the king on the same line. */
function behindKing(move: LinePly): { king: PieceAt; behind: PieceAt } | undefined {
  const king = ['bishop', 'rook', 'queen'].includes(move.role) ? checkedKing(move) : undefined;
  if (!king) return undefined;
  const { board } = positionFromFen(move.fenAfter);
  const to = parseSquare(move.to) as number;
  const k = parseSquare(king.square) as number;
  const piece = { color: move.side, role: move.role };
  // The squares the checking piece would reach through the king, on the line from it to the king.
  const through = attacks(piece, to, board.occupied.without(k)).diff(attacks(piece, to, board.occupied)).intersect(ray(to, k));
  for (const sq of through) {
    const p = board.get(sq);
    if (p?.color === king.side) return { king, behind: { side: p.color, role: p.role, square: makeSquare(sq) } };
  }
  return undefined;
}

/** The other side's pieces that attack the moved piece where it landed but can't take it, each with the piece that pins it to its king. */
function pinnedAttackers(move: LinePly): { piece: PieceAt; by: PieceAt }[] {
  const pos = positionFromFen(move.fenAfter);
  const to = parseSquare(move.to) as number;
  const king = pos.board.kingOf(pos.turn);
  const out: { piece: PieceAt; by: PieceAt }[] = [];
  if (king === undefined) return out;
  for (const from of pos.kingAttackers(to, pos.turn, pos.board.occupied)) {
    const piece = pos.board.get(from);
    if (!piece || piece.role === 'king' || !pos.ctx().blockers.has(from) || pos.isLegal({ from, to })) continue;
    // The pinner: a piece of the mover's that would attack the king were the pinned piece gone.
    for (const s of pos.kingAttackers(king, move.side, pos.board.occupied.without(from))) {
      const p = pos.board.get(s);
      if (p && ray(s, king).has(from)) out.push({ piece: { side: piece.color, role: piece.role, square: makeSquare(from) }, by: { side: p.color, role: p.role, square: makeSquare(s) } });
    }
  }
  return out;
}

/** The mover's bishops, rooks and queen that had squares to go to and have none now that its king stands in their way. */
function blockedByKing(fen: string, move: LinePly): PieceAt[] {
  const before = positionFromFen(fen).board;
  const now = positionFromFen(move.fenAfter).board;
  const to = parseSquare(move.to) as number;
  const out: PieceAt[] = [];
  for (const [sq, piece] of now) {
    if (piece.color !== move.side || !['bishop', 'rook', 'queen'].includes(piece.role) || before.get(sq)?.role !== piece.role) continue;
    const reach = attacks(piece, sq, before.occupied).diff(before[move.side]);
    if (reach.has(to) && attacks(piece, sq, now.occupied).diff(now[move.side]).isEmpty()) out.push({ side: piece.color, role: piece.role, square: makeSquare(sq) });
  }
  return out;
}

/** The pieces of the mating side, other than the one giving mate, that protect it, when it stands next to the mated king. */
function guardsOfGiver(fen: string, giver: PieceAt): PieceAt[] {
  const pos = positionFromFen(fen);
  const sq = parseSquare(giver.square) as number;
  const king = pos.board.kingOf(otherSide(giver.side));
  if (king === undefined || !kingAttacks(king).has(sq)) return [];
  return [...pos.kingAttackers(sq, giver.side, pos.board.occupied)].map((from) => ({ side: giver.side, role: pos.board.get(from)?.role as Role, square: makeSquare(from) }));
}

/** The pieces of `side` next to its king that take away its square: the other side would not cover it if they were gone. */
function ownNeighbours(fen: string, side: Side): PieceAt[] {
  const pos = positionFromFen(fen);
  const king = pos.board.kingOf(side);
  if (king === undefined) return [];
  const out: PieceAt[] = [];
  for (const sq of kingAttacks(king)) {
    const piece = pos.board.get(sq);
    if (piece?.color === side && pos.kingAttackers(sq, otherSide(side), pos.board.occupied.without(king).without(sq)).isEmpty()) out.push({ side, role: piece.role, square: makeSquare(sq) });
  }
  return out;
}

/** The king the moved piece itself gives check to, if it does (not a check it uncovered). */
function checkedKing(move: LinePly): PieceAt | undefined {
  const king = positionFromFen(move.fenAfter).board.kingOf(otherSide(move.side));
  if (king === undefined || !guards(move.fenAfter, move.to).has(king)) return undefined;
  return { side: otherSide(move.side), role: 'king', square: makeSquare(king) };
}

/** The squares the piece on `square` attacks in `fen`. */
function guards(fen: string, square: string): SquareSet {
  const { board } = positionFromFen(fen);
  const sq = parseSquare(square) as number;
  const piece = board.get(sq);
  return piece ? attacks(piece, sq, board.occupied) : SquareSet.empty();
}

/** The wings the move costs the mover castling on, which it still had. */
function castlingLost(fen: string, after: string, side: Side): ('king' | 'queen')[] {
  const rights = (f: string) => (f.split(' ')[2] ?? '-').split('').filter((c) => (side === 'white' ? /[KQ]/ : /[kq]/).test(c)).map((c) => (/[Kk]/.test(c) ? 'king' : 'queen') as 'king' | 'queen');
  const has = rights(after);
  return rights(fen).filter((w) => !has.includes(w));
}

/** "Black's knight on d4". */
function named(p: PieceAt): string {
  return `${SIDE_NAMES[p.side]}'s ${p.role} on ${p.square}`;
}

function rank(role: Role | undefined): number {
  return role === undefined || role === 'king' ? 100 : VALUE[role];
}

function sum(roles: readonly Role[]): number {
  return roles.reduce((total, r) => total + VALUE[r], 0);
}

/** "pawns on f7, g7 and h7 and a rook on f8". */
function pieceList(group: readonly PieceAt[]): string {
  const squares = new Map<Role, string[]>();
  for (const p of group) squares.set(p.role, [...(squares.get(p.role) ?? []), p.square]);
  return list([...squares].map(([role, at]) => `${role}${at.length > 1 ? 's' : ''} on ${list(at)}`));
}

/** "a knight and two pawns". */
function pieces(roles: readonly Role[]): string {
  const order: Role[] = ['queen', 'rook', 'bishop', 'knight', 'pawn'];
  return list(
    order
      .map((role) => ({ role, n: roles.filter((r) => r === role).length }))
      .filter((p) => p.n)
      .map((p) => (p.n === 1 ? `a ${p.role}` : `${NUMBERS[p.n] ?? p.n} ${p.role}s`)),
  );
}

/** "a, b and c". */
function list(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
}
