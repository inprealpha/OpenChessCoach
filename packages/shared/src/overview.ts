// A Review's overview of the whole game: the facts its brief is built from (ADR 0004), and where
// its text names the game's moves, so the screen can link each one to its place in the game and
// the desktop can tell which moves the overview named.
import type { GradedMove } from './analysis.ts';
import { moveLabel } from './chess.ts';
import type { GameFacts, GameMoveFact } from './coach/types.ts';
import { pickStandouts } from './key-moments.ts';
import type { GameDetail, GradeCounts, OverviewMove } from './protocol.ts';

/** A piece of an overview's text: words, or a move of the game it names. */
export type OverviewSegment = { text: string; move?: OverviewMove };

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The move's SAN as a word of its own, its check or mate sign optional: the Coach may leave it off.
 * Nothing may follow that would make it a longer move: O-O is not the start of O-O-O.
 */
function sanPattern(san: string): string {
  return `${escaped(san.replace(/[+#]$/, ''))}[+#]?(?![\\w+#=-])`;
}

/** The move with its number, as a scoresheet writes it, with or without the space: "11. Bxf7+", "24… Nxf2", "24...Nxf2". */
function numberedPattern(move: OverviewMove): RegExp {
  // From the label, not the ply: a game set up from a position starts at its own move number.
  const number = /^\d+/.exec(move.label)?.[0] ?? '';
  const dots = move.side === 'white' ? '\\.' : '(?:…|\\.\\.\\.|\\. ?\\.\\.\\.)';
  return new RegExp(`(?<![\\w.])${number}${dots} ?${sanPattern(move.san)}`, 'g');
}

/**
 * Splits an overview's text at the moves of the game it names, each found by its number and SAN
 * ("24… Nxf2", also "24...Nxf2"). A SAN alone is never linked: it may be a key moment's better
 * move, which the game didn't play, or the same SAN played at another point of the game.
 */
export function overviewSegments(text: string, moves: readonly OverviewMove[]): OverviewSegment[] {
  const found: { start: number; end: number; move: OverviewMove }[] = [];
  const overlaps = (start: number, end: number) => found.some((f) => start < f.end && f.start < end);
  for (const move of moves) {
    for (const m of text.matchAll(numberedPattern(move))) {
      if (!overlaps(m.index, m.index + m[0].length)) found.push({ start: m.index, end: m.index + m[0].length, move });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const out: OverviewSegment[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) out.push({ text: text.slice(at, f.start) });
    out.push({ text: text.slice(f.start, f.end), move: f.move });
    at = f.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

function moveFact(m: GradedMove): GameMoveFact {
  return { ply: m.ply, side: m.side, uci: m.uci, san: m.san, label: moveLabel(m.fenBefore, m.san), grade: m.grade };
}

/**
 * The whole game for the overview's brief, from the Review's own graded moves (ADR 0004): each
 * side's Move Grade counts, the key moments with the Engine's best move instead, and the other
 * moves that stood out on both sides. No move's full analysis.
 */
export function gameFacts(game: Pick<GameDetail, 'opening' | 'result'>, graded: readonly GradedMove[], moments: readonly GradedMove[]): GameFacts {
  const grades: GameFacts['grades'] = { white: {}, black: {} };
  for (const m of graded) {
    const side: GradeCounts = grades[m.side];
    side[m.grade] = (side[m.grade] ?? 0) + 1;
  }
  return {
    opening: game.opening,
    result: game.result,
    grades,
    moments: moments.map((m) => {
      const best = m.candidates[0];
      return { ...moveFact(m), ...(best && best.uci !== m.uci ? { better: { uci: best.uci, san: best.san } } : {}) };
    }),
    standouts: pickStandouts(graded, new Set(moments.map((m) => m.ply))).map((s) => ({ ...moveFact(s.move), only: s.only })),
  };
}

/**
 * The game's moves an overview names, in game order: the key moments and standout moves its text
 * names with their number, or its guarded reply lists. A UCI in the reply counts only when it can
 * be no other move in the brief: the same UCI can be a key moment's better move, or a piece going
 * the same way at another point of the game. Any other move was never the Engine's and the guard
 * has already stripped it (ADR 0002).
 */
export function namedMoves(facts: GameFacts, text: string, guarded: readonly string[]): OverviewMove[] {
  const played = [...facts.moments, ...facts.standouts].sort((a, b) => a.ply - b.ply);
  const all: OverviewMove[] = played.map((m) => ({ ply: m.ply, side: m.side, san: m.san, grade: m.grade, label: m.label }));
  const inText = new Set(overviewSegments(text, all).flatMap((s) => (s.move ? [s.move.ply] : [])));
  const ucis = [...played.map((m) => m.uci), ...facts.moments.flatMap((m) => (m.better ? [m.better.uci] : []))];
  const listed = (uci: string) => guarded.includes(uci) && ucis.filter((u) => u === uci).length === 1;
  return all.filter((m, i) => inText.has(m.ply) || listed(played[i]?.uci ?? ''));
}
