// Bundled Lesson data (ADR 0005, ADR 0008). Opening Lessons: main lines from Lichess's
// chess-openings, move popularity by rating band from the Lichess games database, and notes
// adapted from Wikibooks. Theme and endgame Lessons: worked examples translated from Wikibooks and
// Wikipedia, and positions from the Lichess puzzle database.
import { gradeFromAnalyses } from '../analysis.ts';
import { INITIAL_FEN, isValidFen, outcomeOf, playUci, positionKey, turnOf, type Side } from '../chess.ts';
import type { Engine } from '../engine.ts';
import type { PlayerLevel } from '../protocol.ts';

export const WIKIBOOKS_LICENCE = 'CC BY-SA 4.0';
export const WIKIBOOKS_LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
export const LICHESS_LICENCE = 'CC0 1.0';
export const LICHESS_LICENCE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

export interface Credit {
  /** Where the text or position was adapted from. */
  source: string;
  url: string;
  licence: string;
  licenceUrl: string;
  authors: string;
}

export interface MoveStat {
  uci: string;
  san: string;
  /** Share of games at this rating band that played this move here, 0 to 100. */
  percent: number;
  games: number;
}

export interface LessonNode {
  /** Index in the part's main line of the move played from this position. */
  ply: number;
  fen: string;
  /** Whether the Player chooses the move here. */
  decision: boolean;
  /** The main-line move from this position. */
  main: string;
  mainSan: string;
  /** The most common moves here by rating band. Empty where the games database has too few games. */
  popular: Record<PlayerLevel, MoveStat[]>;
  /** Terse notes for the Player's decisions, with their credit. */
  notes?: { text: string; credit: Credit };
}

/** One worked example in a Lesson: a starting position and the line the Player is taken through. */
export interface LessonPart {
  title: string;
  /** The position the part starts from. */
  fen: string;
  /** The side the Player plays in this part. */
  side: Side;
  /** What to look for, shown before the part's first decision. Opening Lessons have none. */
  text?: string;
  /** Where the position and the line come from. */
  credit: Credit;
  /** Main line in UCI from the part's starting position. */
  mainLine: string[];
  nodes: LessonNode[];
}

export type LessonKind = 'opening' | 'theme' | 'endgame';

/** A position the Player plays out against the Engine after an endgame Lesson. */
export interface PlayOut {
  title: string;
  fen: string;
  side: Side;
  /** Mate the lone king, or promote a pawn. */
  goal: 'mate' | 'promote';
}

export interface LessonData {
  id: string;
  name: string;
  kind: LessonKind;
  /** The side the Player plays: for an opening, its colour; otherwise the first part's. */
  side: Side;
  /** ECO code, for openings. */
  eco?: string;
  /** Lichess puzzle OpeningTags that belong to this Lesson. */
  puzzleTags: string[];
  /** Lichess puzzle themes that belong to this Lesson. */
  puzzleThemes: string[];
  intro: { text: string; credit: Credit };
  parts: LessonPart[];
  playOut?: PlayOut;
  /** Where the popularity numbers come from. */
  statsSource?: string;
}

/** Rating bands for "what players at your level play here". */
export const BANDS: Record<PlayerLevel, { min: number; max: number; label: string }> = {
  beginner: { min: 0, max: 1399, label: 'under 1400' },
  casual: { min: 1400, max: 1799, label: '1400 to 1799' },
  club: { min: 1800, max: 9999, label: '1800 and above' },
};

export function bandFor(level: PlayerLevel, rating: number | null): PlayerLevel {
  if (rating === null) return level;
  if (rating < BANDS.casual.min) return 'beginner';
  if (rating < BANDS.club.min) return 'casual';
  return 'club';
}

export interface Decision {
  part: LessonPart;
  /** Index of the part in the Lesson. */
  partIndex: number;
  node: LessonNode;
}

/** The Player's decisions in order, across every part. */
export function decisions(lesson: LessonData): Decision[] {
  return lesson.parts.flatMap((part, partIndex) => part.nodes.filter((n) => n.decision).map((node) => ({ part, partIndex, node })));
}

/**
 * The ADR 0008 Engine check: every move the Player is asked to find is graded Best or Good at
 * `depth`, so a Player who plays the book move is never told it was a Mistake. Returns the moves
 * graded worse.
 */
export async function engineCheck(engine: Engine, lesson: LessonData, depth: number): Promise<string[]> {
  const failures: string[] = [];
  const options = { multiPv: 5, depth };
  for (const { partIndex, node } of decisions(lesson)) {
    const after = playUci(node.fen, node.main)?.fenAfter as string;
    const before = await engine.analyse(node.fen, options);
    const next = outcomeOf(after) ? undefined : await engine.analyse(after, options);
    const { grade } = gradeFromAnalyses(node.ply + 1, node.main, before, next);
    if (grade !== 'Best' && grade !== 'Good') failures.push(`${lesson.id} part ${partIndex + 1} ${node.mainSan} at depth ${depth}: ${grade}`);
  }
  return failures;
}

/** The ADR 0005 and 0008 check: every line legal, every text and position credited. Returns the problems found. */
export function validateLesson(lesson: LessonData): string[] {
  const problems: string[] = [];
  if (!checkTextCredit(lesson.intro.credit)) problems.push(`${lesson.id}: the intro is missing its credit`);
  if (!lesson.intro.text.trim()) problems.push(`${lesson.id}: the intro is empty`);
  if (!lesson.parts.length) problems.push(`${lesson.id}: has no parts`);
  if (lesson.parts[0] && lesson.side !== lesson.parts[0].side) problems.push(`${lesson.id}: the Lesson's side differs from its first part's`);
  if (lesson.kind === 'opening') {
    if (lesson.parts.length !== 1 || lesson.parts[0]?.fen !== INITIAL_FEN) problems.push(`${lesson.id}: an opening is one part from the starting position`);
    if (!lesson.eco) problems.push(`${lesson.id}: an opening needs its ECO code`);
  }
  lesson.parts.forEach((part, i) => problems.push(...validatePart(lesson, part, i)));
  if (lesson.playOut) {
    const p = lesson.playOut;
    if (!isValidFen(p.fen) || outcomeOf(p.fen)) problems.push(`${lesson.id}: the play-out position is not a playable position`);
  }
  return problems;
}

function validatePart(lesson: LessonData, part: LessonPart, index: number): string[] {
  const problems: string[] = [];
  const name = lesson.parts.length > 1 ? `${lesson.id} part ${index + 1}` : lesson.id;
  const where = (n: LessonNode) => `${name} ply ${n.ply}`;
  if (!isValidFen(part.fen)) return [`${name}: the starting position is not valid`];
  if (!checkPositionCredit(part.credit)) problems.push(`${name}: the position is missing its credit`);
  if (lesson.kind !== 'opening' && !part.text?.trim()) problems.push(`${name}: a part needs its text`);
  let fen = part.fen;
  part.mainLine.forEach((uci, ply) => {
    const played = playUci(fen, uci);
    if (!played) {
      problems.push(`${name}: main-line move ${ply + 1} (${uci}) is not legal`);
      return;
    }
    fen = played.fenAfter;
  });
  if (part.nodes.length !== part.mainLine.length) problems.push(`${name}: expected one node per main-line move`);
  if (!part.nodes.some((n) => n.decision)) problems.push(`${name}: the Player has no decision`);
  fen = part.fen;
  for (const node of part.nodes) {
    if (positionKey(node.fen) !== positionKey(fen)) problems.push(`${where(node)}: the node's position does not follow the main line`);
    if (node.main !== part.mainLine[node.ply]) problems.push(`${where(node)}: the node's main move differs from the main line`);
    const played = playUci(node.fen, node.main);
    if (!played) problems.push(`${where(node)}: main move ${node.main} is not legal`);
    else if (played.san !== node.mainSan) problems.push(`${where(node)}: SAN ${node.mainSan} should be ${played.san}`);
    if (node.decision !== (turnOf(node.fen) === part.side)) problems.push(`${where(node)}: decision flag does not match the Player's side`);
    for (const [band, stats] of Object.entries(node.popular)) {
      for (const s of stats) {
        const p = playUci(node.fen, s.uci);
        if (!p) problems.push(`${where(node)}: popular move ${s.uci} (${band}) is not legal`);
        else if (p.san !== s.san) problems.push(`${where(node)}: popular move SAN ${s.san} should be ${p.san}`);
      }
    }
    if (node.decision && lesson.kind === 'opening' && !node.notes?.text.trim()) problems.push(`${where(node)}: a decision has no notes`);
    if (node.notes && !checkTextCredit(node.notes.credit)) problems.push(`${where(node)}: notes are missing their credit`);
    fen = played?.fenAfter ?? fen;
  }
  return problems;
}

/** Text is adapted from Wikibooks or Wikipedia, under CC BY-SA. */
function checkTextCredit(credit: Credit | undefined): boolean {
  return Boolean(
    credit &&
      credit.licence === WIKIBOOKS_LICENCE &&
      credit.licenceUrl === WIKIBOOKS_LICENCE_URL &&
      ((/^https:\/\/en\.wikibooks\.org\/wiki\/(Chess_Opening_Theory|Chess\/)/.test(credit.url) && credit.source.includes('Wikibooks')) ||
        (/^https:\/\/en\.wikipedia\.org\/wiki\//.test(credit.url) && credit.source.includes('Wikipedia'))) &&
      credit.authors.trim(),
  );
}

/** A position comes from the same texts, or from the Lichess puzzle database (CC0). */
function checkPositionCredit(credit: Credit | undefined): boolean {
  if (checkTextCredit(credit)) return true;
  return Boolean(
    credit &&
      credit.licence === LICHESS_LICENCE &&
      credit.licenceUrl === LICHESS_LICENCE_URL &&
      /^https:\/\/lichess\.org\/training\/[A-Za-z0-9]+$/.test(credit.url) &&
      credit.source.includes('Lichess') &&
      credit.authors.trim(),
  );
}
