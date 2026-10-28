// Bundled Lesson data (ADR 0005, ADR 0008, ADR 0011). Every position and line comes from open data:
// Lichess's chess-openings, puzzle and games databases (CC0), or Wikibooks and Wikipedia pages
// (CC BY-SA 4.0). Explanations are written for OpenChessCoach; a text kept from Wikibooks or
// Wikipedia carries its credit. Opening Lessons add move popularity by rating band from the Lichess
// games database.
import { gradeFromAnalyses } from '../analysis.ts';
import { INITIAL_FEN, isValidFen, outcomeOf, playUci, positionKey, turnOf, type Side } from '../chess.ts';
import type { Engine } from '../engine.ts';
import type { PlayerLevel } from '../protocol.ts';

export const WIKIBOOKS_LICENCE = 'CC BY-SA 4.0';
export const WIKIBOOKS_LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
export const LICHESS_LICENCE = 'CC0 1.0';
export const LICHESS_LICENCE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/** The four tracks of the course (ADR 0011), in the order the Learn screen shows them. */
export const TRACKS = ['themes', 'endgames', 'openings', 'thinking'] as const;
export type Track = (typeof TRACKS)[number];

/** The course's levels, easiest first. Advanced is future work (docs/course-outline.md). */
export const COURSE_LEVELS = ['beginner', 'intermediate'] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];

/** Longest learning goal and key idea, so the Coach brief stays within its budget (ADR 0004). */
export const MAX_GOAL = 240;
export const MAX_KEY_IDEA = 140;

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
  /** Terse notes for the Player's decisions. A note kept from Wikibooks or Wikipedia carries its credit. */
  notes?: { text: string; credit?: Credit };
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
  /** Present when `text` is kept from Wikibooks or Wikipedia. */
  textCredit?: Credit;
  /** What this position teaches, in one line (ADR 0011). Shown once the part is played, never before. */
  keyIdea: string;
  /** Where the position and the line come from. */
  credit: Credit;
  /** Main line in UCI from the part's starting position. */
  mainLine: string[];
  nodes: LessonNode[];
}

/**
 * How a Lesson is taught. An opening is one line from the starting position, with move popularity
 * and a note at every decision. The others are several positions: a Theme, an endgame, or a way
 * of thinking during a game (including the opening principles).
 */
export type LessonKind = 'opening' | 'theme' | 'endgame' | 'thinking';

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
  /** Where the Lesson sits in the course (ADR 0011). */
  track: Track;
  level: CourseLevel;
  /** What the Player can do afterwards, in one or two plain sentences (ADR 0011). */
  goal: string;
  /** Ids of the Lessons a Player should know first. Nothing is locked: this only orders the suggestions. */
  priorKnowledge: string[];
  /** The side the Player plays: for an opening, its colour; otherwise the first part's. */
  side: Side;
  /** ECO code, for openings. */
  eco?: string;
  /** Lichess puzzle OpeningTags that belong to this Lesson. */
  puzzleTags: string[];
  /** Lichess puzzle themes that belong to this Lesson. */
  puzzleThemes: string[];
  /** A text kept from Wikibooks or Wikipedia carries its credit. */
  intro: { text: string; credit?: Credit };
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

/** Which tracks a kind of Lesson may sit in: the opening principles are taught in the openings track. */
const KIND_TRACKS: Record<LessonKind, readonly Track[]> = {
  opening: ['openings'],
  theme: ['themes'],
  endgame: ['endgames'],
  thinking: ['thinking', 'openings'],
};

/**
 * The ADR 0005, 0008 and 0011 check: every line legal, every position credited, every kept text
 * credited, and the goal, prior knowledge and key ideas in place. Pass `ids` (every Lesson id) to
 * check that the prior knowledge names real Lessons. Returns the problems found.
 */
export function validateLesson(lesson: LessonData, ids?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (lesson.intro.credit && !checkTextCredit(lesson.intro.credit)) problems.push(`${lesson.id}: the intro's credit is not a Wikibooks or Wikipedia credit`);
  if (!lesson.intro.text.trim()) problems.push(`${lesson.id}: the intro is empty`);
  if (!lesson.parts.length) problems.push(`${lesson.id}: has no parts`);
  if (!TRACKS.includes(lesson.track)) problems.push(`${lesson.id}: unknown track ${lesson.track}`);
  else if (!KIND_TRACKS[lesson.kind]?.includes(lesson.track)) problems.push(`${lesson.id}: a ${lesson.kind} Lesson cannot sit in the ${lesson.track} track`);
  if (!COURSE_LEVELS.includes(lesson.level)) problems.push(`${lesson.id}: unknown level ${lesson.level}`);
  if (!lesson.goal?.trim()) problems.push(`${lesson.id}: the Lesson has no learning goal`);
  else if (lesson.goal.length > MAX_GOAL) problems.push(`${lesson.id}: the learning goal is longer than ${MAX_GOAL} characters`);
  if (!Array.isArray(lesson.priorKnowledge)) problems.push(`${lesson.id}: the Lesson has no prior knowledge list`);
  else {
    if (lesson.priorKnowledge.includes(lesson.id)) problems.push(`${lesson.id}: a Lesson cannot be its own prior knowledge`);
    for (const id of lesson.priorKnowledge) if (ids && !ids.has(id)) problems.push(`${lesson.id}: prior knowledge ${id} is not a Lesson`);
  }
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

/**
 * Prior knowledge must not go round in a circle, or no Lesson in the circle could ever be suggested
 * first. Returns the circles found, each as the ids in order.
 */
export function priorKnowledgeCycles(lessons: readonly Pick<LessonData, 'id' | 'priorKnowledge'>[]): string[][] {
  const prior = new Map(lessons.map((l) => [l.id, l.priorKnowledge]));
  const cycles: string[][] = [];
  const done = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (path.includes(id)) {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    if (done.has(id)) return;
    for (const p of prior.get(id) ?? []) visit(p, [...path, id]);
    done.add(id);
  };
  for (const l of lessons) visit(l.id, []);
  return cycles;
}

function validatePart(lesson: LessonData, part: LessonPart, index: number): string[] {
  const problems: string[] = [];
  const name = lesson.parts.length > 1 ? `${lesson.id} part ${index + 1}` : lesson.id;
  const where = (n: LessonNode) => `${name} ply ${n.ply}`;
  if (!isValidFen(part.fen)) return [`${name}: the starting position is not valid`];
  if (!checkPositionCredit(part.credit)) problems.push(`${name}: the position is missing its credit`);
  if (part.textCredit && !checkTextCredit(part.textCredit)) problems.push(`${name}: the text's credit is not a Wikibooks or Wikipedia credit`);
  if (lesson.kind !== 'opening' && !part.text?.trim()) problems.push(`${name}: a part needs its text`);
  if (!part.keyIdea?.trim()) problems.push(`${name}: a part has no key idea`);
  else if (/\n/.test(part.keyIdea)) problems.push(`${name}: the key idea must be one line`);
  else if (part.keyIdea.length > MAX_KEY_IDEA) problems.push(`${name}: the key idea is longer than ${MAX_KEY_IDEA} characters`);
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
    if (node.notes?.credit && !checkTextCredit(node.notes.credit)) problems.push(`${where(node)}: the note's credit is not a Wikibooks or Wikipedia credit`);
    fen = played?.fenAfter ?? fen;
  }
  return problems;
}

/** Text kept from Wikibooks or Wikipedia, under CC BY-SA. */
export function checkTextCredit(credit: Credit | undefined): boolean {
  return Boolean(
    credit &&
      credit.licence === WIKIBOOKS_LICENCE &&
      credit.licenceUrl === WIKIBOOKS_LICENCE_URL &&
      ((/^https:\/\/en\.wikibooks\.org\/wiki\/(Chess_Opening_Theory|Chess\/)/.test(credit.url) && credit.source.includes('Wikibooks')) ||
        (/^https:\/\/en\.wikipedia\.org\/wiki\//.test(credit.url) && credit.source.includes('Wikipedia'))) &&
      credit.authors.trim(),
  );
}

/** Lichess's open data under CC0: a puzzle, a game from the games database, or the chess-openings list. */
const LICHESS_SOURCE = /^https:\/\/(lichess\.org\/training\/[A-Za-z0-9]{5}|lichess\.org\/[A-Za-z0-9]{8}(#\d+)?|github\.com\/lichess-org\/chess-openings)$/;

/** A position comes from a Wikibooks or Wikipedia page (a famous game, say), or from Lichess's open data. */
export function checkPositionCredit(credit: Credit | undefined): boolean {
  if (checkTextCredit(credit)) return true;
  return Boolean(
    credit &&
      credit.licence === LICHESS_LICENCE &&
      credit.licenceUrl === LICHESS_LICENCE_URL &&
      LICHESS_SOURCE.test(credit.url) &&
      credit.source.includes('Lichess') &&
      credit.authors.trim(),
  );
}

/** A text the Lessons adapted from Wikibooks or Wikipedia before ADR 0011 (`data/open-texts.json`). */
export interface OpenText {
  url: string;
  text: string;
}

/** Runs of this many words in a row, moves left out, count as kept text. */
const KEPT_WORDS = 8;

function wordRuns(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9.+#=-]+/)
    // Moves and move numbers ("3.Bc4", "Nxe5+", "O-O") are facts, not wording: leave them out.
    .filter((w) => w && !/\d/.test(w) && !/^(o-o(-o)?|[kqrbn]?x?[a-h]?[1-8]?)$/.test(w));
  const runs = new Set<string>();
  for (let i = 0; i + KEPT_WORDS <= words.length; i++) runs.add(words.slice(i, i + KEPT_WORDS).join(' '));
  return runs;
}

/**
 * The ADR 0011 credit check: a Lesson text without a credit must not keep wording from the earlier
 * Wikibooks and Wikipedia texts. Returns a problem for each uncredited text that shares a run of
 * words with one of them.
 */
export function keptOpenText(lesson: LessonData, openTexts: readonly OpenText[]): string[] {
  const open = openTexts.map((t) => ({ url: t.url, runs: wordRuns(t.text) }));
  const uncredited: { where: string; text: string }[] = [];
  if (!lesson.intro.credit) uncredited.push({ where: 'the intro', text: lesson.intro.text });
  lesson.parts.forEach((part, i) => {
    const name = `part ${i + 1}`;
    if (part.text && !part.textCredit) uncredited.push({ where: `${name}'s text`, text: part.text });
    for (const n of part.nodes) if (n.notes && !n.notes.credit) uncredited.push({ where: `${name} ply ${n.ply}'s note`, text: n.notes.text });
  });
  const problems: string[] = [];
  for (const { where, text } of uncredited) {
    const runs = wordRuns(text);
    const source = open.find((o) => [...runs].some((r) => o.runs.has(r)));
    if (source) problems.push(`${lesson.id}: ${where} keeps wording from ${source.url} without its credit`);
  }
  return problems;
}
