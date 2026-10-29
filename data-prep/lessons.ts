// Assembles the bundled Lessons from their sources, then runs the Lesson data check. Writes
// data/lessons/<id>.json and data/lessons/index.json, in the course order of data-prep/course.ts.
//
// Usage: node data-prep/lessons.ts            (every Lesson, and the index)
//        node data-prep/lessons.ts <id> ...   (only these Lessons; the index is left alone)
// Inputs:
// - data/lesson-sources/<id>.json, one per Lesson (the `Source` type in sources.ts). Positions and
//   lines come from Lichess's open data (CC0) or from Wikibooks and Wikipedia pages (CC BY-SA 4.0).
//   Text is written for OpenChessCoach; a text kept from Wikibooks or Wikipedia names its page in
//   `introUrl`, `textUrl` or a note's `url`, and is credited (ADR 0005, ADR 0012).
// - data/lesson-stats.json (from lesson-stats.ts): move popularity for the opening Lessons.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { INITIAL_FEN, playSan, playUci, positionKey, turnOf } from '@chess-coach/shared/chess';
import type { Side } from '@chess-coach/shared/chess';
import type { CatalogueItem } from '@chess-coach/shared/content/course';
import {
  decisions,
  keptOpenText,
  LICHESS_LICENCE,
  LICHESS_LICENCE_URL,
  priorKnowledgeCycles,
  validateLesson,
  WIKIBOOKS_LICENCE,
  WIKIBOOKS_LICENCE_URL,
  type Credit,
  type LessonData,
  type LessonNode,
  type LessonPart,
  type MoveStat,
  type OpenText,
} from '@chess-coach/shared/content/lessons';
import type { PlayerLevel } from '@chess-coach/shared/protocol';
import { COURSE } from './course.ts';
import { readSources, type Source } from './sources.ts';

type Stats = {
  source: string;
  games: number;
  positions: Record<string, Record<PlayerLevel, { total: number; moves: { uci: string; games: number }[] }>>;
};

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const stats = read<Stats>('../data/lesson-stats.json');
const sources = readSources();
const openTexts = read<{ texts: OpenText[] }>('../data/open-texts.json').texts;

/** The credit for a position or a kept text, from its source URL. */
function credit(url: string): Credit {
  const lichess = (source: string): Credit => ({ source, url, licence: LICHESS_LICENCE, licenceUrl: LICHESS_LICENCE_URL, authors: 'Lichess' });
  const puzzle = url.match(/^https:\/\/lichess\.org\/training\/(\w+)$/);
  if (puzzle) return { ...lichess(`Lichess puzzle database, puzzle ${puzzle[1]}`), authors: 'Lichess; the position is from a game played there' };
  if (url === 'https://github.com/lichess-org/chess-openings') return { ...lichess('Lichess chess-openings'), authors: 'Lichess contributors' };
  const game = url.match(/^https:\/\/lichess\.org\/(\w{8})(#\d+)?$/);
  if (game) return { ...lichess(`Lichess games database, game ${game[1]}`), authors: 'Lichess; the players of the game' };
  const wiki = url.startsWith('https://en.wikipedia.org/wiki/') ? 'Wikipedia' : 'Wikibooks';
  const page = decodeURIComponent(url.replace(/^https:\/\/en\.wiki(books|pedia)\.org\/wiki\//, '')).replace(/_/g, ' ');
  return {
    source: `${wiki}, ${page}`,
    url,
    licence: WIKIBOOKS_LICENCE,
    licenceUrl: WIKIBOOKS_LICENCE_URL,
    authors: `${wiki} contributors (see the page history)`,
  };
}

/**
 * The months of the games, "January 2013, July 2014 and June 2015", from the names of the Lichess
 * database files they came from (lichess_db_standard_rated_2013-01.pgn.zst).
 */
function months(files: string): string {
  const names = files.split(', ').map((file) => {
    const month = file.match(/_(\d{4})-(\d{2})\.pgn/);
    if (!month) throw new Error(`No month in the games file name ${file}`);
    return new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  });
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

const MIN_GAMES = 20;

function popular(fen: string, level: PlayerLevel): MoveStat[] {
  const entry = stats.positions[positionKey(fen)]?.[level];
  if (!entry || entry.total < MIN_GAMES) return [];
  return entry.moves.slice(0, 5).map((m) => {
    const played = playUci(fen, m.uci);
    if (!played) throw new Error(`Illegal popular move ${m.uci} in ${fen}`);
    return { uci: played.uci, san: played.san, percent: Math.round((m.games / entry.total) * 1000) / 10, games: m.games };
  });
}

const NO_POPULARITY = (): LessonNode['popular'] => ({ beginner: [], casual: [], club: [] });

/** A part's nodes from its SAN line, with the notes for the Player's moves. */
function buildPart(
  id: string,
  start: string,
  side: Side,
  line: string,
  partNotes: { ply: number; san: string; text: string; url?: string }[],
  popularity: (fen: string) => LessonNode['popular'],
): Pick<LessonPart, 'mainLine' | 'nodes'> {
  const nodes: LessonNode[] = [];
  const mainLine: string[] = [];
  let fen = start;
  line.split(' ').forEach((san, ply) => {
    const played = playSan(fen, san);
    if (!played) throw new Error(`${id}: illegal ${san}`);
    const note = partNotes.find((d) => d.ply === ply);
    if (note && note.san !== played.san) throw new Error(`${id}: note for ply ${ply} is about ${note.san}, not ${played.san}`);
    nodes.push({
      ply,
      fen,
      decision: turnOf(fen) === side,
      main: played.uci,
      mainSan: played.san,
      popular: popularity(fen),
      ...(note ? { notes: { text: note.text, ...(note.url ? { credit: credit(note.url) } : {}) } } : {}),
    });
    mainLine.push(played.uci);
    fen = played.fenAfter;
  });
  for (const note of partNotes) if (!nodes[note.ply]) throw new Error(`${id}: note for ply ${note.ply} is past the end of the line`);
  return { mainLine, nodes };
}

/** A Lesson from its source. */
function build(src: Source): LessonData {
  const parts: LessonPart[] = src.parts.map((p, i) => {
    const fen = p.fen === 'start' ? INITIAL_FEN : p.fen;
    const popularity = src.kind === 'opening' ? (f: string): LessonNode['popular'] => ({ beginner: popular(f, 'beginner'), casual: popular(f, 'casual'), club: popular(f, 'club') }) : NO_POPULARITY;
    return {
      title: p.title,
      fen,
      side: p.side,
      keyIdea: p.keyIdea,
      ...(p.text ? { text: p.text } : {}),
      ...(p.textUrl ? { textCredit: credit(p.textUrl) } : {}),
      credit: credit(p.url),
      ...buildPart(src.parts.length > 1 ? `${src.id} part ${i + 1}` : src.id, fen, p.side, p.line, p.notes ?? [], popularity),
    };
  });
  return {
    id: src.id,
    name: src.name,
    kind: src.kind,
    track: src.track,
    level: src.level,
    goal: src.goal,
    priorKnowledge: src.priorKnowledge,
    side: src.side,
    ...(src.eco ? { eco: src.eco } : {}),
    puzzleTags: src.puzzleTags ?? [],
    puzzleThemes: src.puzzleThemes ?? [],
    intro: { text: src.intro, ...(src.introUrl ? { credit: credit(src.introUrl) } : {}) },
    parts,
    ...(src.playOut ? { playOut: src.playOut } : {}),
    ...(src.kind === 'opening' ? { statsSource: `Lichess games database (CC0): ${stats.games.toLocaleString('en')} rated games from ${months(stats.source)}` } : {}),
  };
}

const only = process.argv.slice(2);
let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error(message);
};
for (const id of only) if (!sources.has(id)) fail(`No source for ${id} in data/lesson-sources/`);
if (!only.length) for (const id of COURSE) if (!sources.has(id)) fail(`${id} is in data-prep/course.ts but has no source in data/lesson-sources/`);
for (const id of sources.keys()) if (!COURSE.includes(id)) fail(`${id} has a source but is not in data-prep/course.ts`);
// Prior knowledge may name a Lesson of the course whose source is still being written.
const ids = new Set([...sources.keys(), ...COURSE]);
const lessons: LessonData[] = [];
mkdirSync(new URL('../data/lessons/', import.meta.url), { recursive: true });
for (const id of only.length ? only : COURSE) {
  const src = sources.get(id);
  if (!src) continue;
  if (src.id !== id) fail(`data/lesson-sources/${id}.json has the id ${src.id}`);
  let lesson: LessonData;
  try {
    lesson = build(src);
  } catch (e) {
    fail((e as Error).message);
    continue;
  }
  const problems = [...validateLesson(lesson, ids), ...keptOpenText(lesson, openTexts)];
  if (problems.length) fail(problems.join('\n'));
  lessons.push(lesson);
  writeFileSync(new URL(`../data/lessons/${lesson.id}.json`, import.meta.url), `${JSON.stringify(lesson, null, 1)}\n`);
}
for (const cycle of priorKnowledgeCycles([...sources.values()])) fail(`Prior knowledge goes round in a circle: ${cycle.join(' → ')}`);
if (!only.length) {
  const index: CatalogueItem[] = lessons.map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind,
    track: l.track,
    level: l.level,
    side: l.side,
    ...(l.eco ? { eco: l.eco } : {}),
    goal: l.goal,
    priorKnowledge: l.priorKnowledge,
    decisions: decisions(l).length,
    ...(l.playOut ? { playOut: true } : {}),
  }));
  writeFileSync(new URL('../data/lessons/index.json', import.meta.url), `${JSON.stringify(index, null, 1)}\n`);
}
console.error(failed ? 'Lesson data check FAILED' : `Wrote ${lessons.length} Lessons to data/lessons/${only.length ? ' (the index is unchanged)' : ''}`);
process.exit(failed ? 1 : 0);
