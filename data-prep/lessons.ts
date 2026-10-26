// Assembles the bundled Lessons, then runs the Lesson data check. Writes data/lessons/<id>.json and
// data/lessons/index.json.
//
// Usage: node data-prep/lessons.ts
// Inputs:
// - Openings: the catalogue, data/lesson-stats.json (from lesson-stats.ts) and data/lesson-notes.json
//   (notes adapted once by hand from Wikibooks' Chess Opening Theory, CC BY-SA 4.0).
// - Themes and endgames: data/lesson-topics.json, worked examples translated once by hand from
//   Wikibooks and Wikipedia (CC BY-SA 4.0), and positions from the Lichess puzzle database (CC0)
//   (ADR 0008).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { INITIAL_FEN, playSan, playUci, positionKey, turnOf } from '@chess-coach/shared/chess';
import type { Side } from '@chess-coach/shared/chess';
import {
  decisions,
  LICHESS_LICENCE,
  LICHESS_LICENCE_URL,
  validateLesson,
  WIKIBOOKS_LICENCE,
  WIKIBOOKS_LICENCE_URL,
  type Credit,
  type LessonData,
  type LessonNode,
  type LessonPart,
  type MoveStat,
  type PlayOut,
} from '@chess-coach/shared/content/lessons';
import type { PlayerLevel } from '@chess-coach/shared/protocol';
import { CATALOGUE } from './catalogue.ts';

type Stats = {
  source: string;
  games: number;
  positions: Record<string, Record<PlayerLevel, { total: number; moves: { uci: string; games: number }[] }>>;
};
type Notes = Record<string, { intro: string; introUrl: string; decisions: { ply: number; san: string; text: string; url: string }[] }>;

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const stats = read<Stats>('../data/lesson-stats.json');
const notes = read<Notes>('../data/lesson-notes.json');
type Topic = {
  id: string;
  name: string;
  kind: 'theme' | 'endgame';
  intro: string;
  introUrl: string;
  puzzleThemes?: string[];
  playOut?: PlayOut;
  parts: { title: string; fen: string; side: Side; line: string; url: string; text: string; notes?: { ply: number; san: string; text: string }[] }[];
};
const topics = read<Topic[]>('../data/lesson-topics.json');

function credit(url: string): Credit {
  const lichess = url.match(/^https:\/\/lichess\.org\/training\/(\w+)$/);
  if (lichess) {
    return {
      source: `Lichess puzzle database, puzzle ${lichess[1]}`,
      url,
      licence: LICHESS_LICENCE,
      licenceUrl: LICHESS_LICENCE_URL,
      authors: 'Lichess; the position is from a game played there',
    };
  }
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
  partNotes: { ply: number; san: string; text: string; url: string }[],
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
      ...(note ? { notes: { text: note.text, credit: credit(note.url) } } : {}),
    });
    mainLine.push(played.uci);
    fen = played.fenAfter;
  });
  for (const note of partNotes) if (!nodes[note.ply]) throw new Error(`${id}: note for ply ${note.ply} is past the end of the line`);
  return { mainLine, nodes };
}

const lessons: LessonData[] = [];
for (const entry of CATALOGUE) {
  const n = notes[entry.id];
  if (!n) throw new Error(`No notes for ${entry.id} in data/lesson-notes.json`);
  const part = buildPart(entry.id, INITIAL_FEN, entry.side, entry.mainLine, n.decisions, (fen) => ({
    beginner: popular(fen, 'beginner'),
    casual: popular(fen, 'casual'),
    club: popular(fen, 'club'),
  }));
  lessons.push({
    id: entry.id,
    name: entry.name,
    kind: 'opening',
    side: entry.side,
    eco: entry.eco,
    puzzleTags: entry.puzzleTags,
    puzzleThemes: [],
    intro: { text: n.intro, credit: credit(n.introUrl) },
    parts: [{ title: entry.name, fen: INITIAL_FEN, side: entry.side, credit: credit(n.introUrl), ...part }],
    statsSource: `Lichess games database (CC0): ${stats.source}, ${stats.games.toLocaleString('en')} rated games`,
  });
}
for (const topic of topics) {
  const parts: LessonPart[] = topic.parts.map((p, i) => ({
    title: p.title,
    fen: p.fen,
    side: p.side,
    text: p.text,
    credit: credit(p.url),
    ...buildPart(`${topic.id} part ${i + 1}`, p.fen, p.side, p.line, (p.notes ?? []).map((x) => ({ ...x, url: p.url })), NO_POPULARITY),
  }));
  lessons.push({
    id: topic.id,
    name: topic.name,
    kind: topic.kind,
    side: parts[0]?.side ?? 'white',
    puzzleTags: [],
    puzzleThemes: topic.puzzleThemes ?? [],
    intro: { text: topic.intro, credit: credit(topic.introUrl) },
    parts,
    ...(topic.playOut ? { playOut: topic.playOut } : {}),
  });
}

mkdirSync(new URL('../data/lessons/', import.meta.url), { recursive: true });
let failed = false;
for (const lesson of lessons) {
  const problems = validateLesson(lesson);
  if (problems.length) {
    failed = true;
    console.error(problems.join('\n'));
  }
  writeFileSync(new URL(`../data/lessons/${lesson.id}.json`, import.meta.url), `${JSON.stringify(lesson, null, 1)}\n`);
}
const index = lessons.map((l) => ({
  id: l.id,
  name: l.name,
  kind: l.kind,
  side: l.side,
  ...(l.eco ? { eco: l.eco } : {}),
  decisions: decisions(l).length,
  ...(l.playOut ? { playOut: true } : {}),
}));
writeFileSync(new URL('../data/lessons/index.json', import.meta.url), `${JSON.stringify(index, null, 1)}\n`);
console.error(failed ? 'Lesson data check FAILED' : `Wrote ${index.length} Lessons to data/lessons/`);
process.exit(failed ? 1 : 0);
