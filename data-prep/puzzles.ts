// Picks the bundled Puzzles from the CC0 Lichess puzzle database: the catalogue's openings only,
// beginner-to-club ratings, spread across the rating range. Re-runnable; writes data/puzzles.json.
//
// Usage: node data-prep/puzzles.ts <lichess_db_puzzle.csv | lichess_db_puzzle.csv.zst> [--keep-existing]
// Source: https://database.lichess.org/#puzzles
// --keep-existing keeps the Puzzles already in data/puzzles.json and only picks them for Lessons that
// have none yet, so a newly added opening can get Puzzles from a smaller file.
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { turnOf } from '@chess-coach/shared/chess';
import { tagMatches, validatePuzzles, type PuzzleData, type PuzzleFile } from '@chess-coach/shared/content/puzzles';
import { CATALOGUE } from './catalogue.ts';

const MIN_RATING = 600;
const MAX_RATING = 2000;
const BUCKET = 200;
const PER_BUCKET = 4;

const file = process.argv[2];
if (!file) {
  console.error('Usage: node data-prep/puzzles.ts <lichess_db_puzzle.csv | .csv.zst> [--keep-existing]');
  process.exit(1);
}
const kept: PuzzleData[] = process.argv.includes('--keep-existing')
  ? (JSON.parse(readFileSync(new URL('../data/puzzles.json', import.meta.url), 'utf8')) as PuzzleFile).puzzles
  : [];
const covered = new Set(kept.map((p) => p.lessonId));
const keptIds = new Set(kept.map((p) => p.id));

interface Row extends PuzzleData {
  popularity: number;
  plays: number;
  deviation: number;
  solverMatches: boolean;
}

const candidates = new Map<string, Row[]>();
const input = file.endsWith('.zst') ? createReadStream(file).pipe(createZstdDecompress()) : createReadStream(file);
const rl = createInterface({ input, crlfDelay: Infinity });
let header: string[] | undefined;
for await (const line of rl) {
  const cols = line.split(',');
  if (!header) {
    header = cols;
    continue;
  }
  const r = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ''])) as Record<string, string>;
  const rating = Number(r.Rating);
  if (rating < MIN_RATING || rating > MAX_RATING) continue;
  const tags = (r.OpeningTags ?? '').split(' ').filter(Boolean);
  // The most specific family wins: a Two Knights Defence Puzzle is also an Italian Game one.
  const specificity = (l: (typeof CATALOGUE)[number]) => Math.max(0, ...l.puzzleTags.filter((f) => tags.some((t) => tagMatches(t, [f]))).map((f) => f.length));
  const lesson = CATALOGUE.filter((l) => specificity(l) > 0).sort((a, b) => specificity(b) - specificity(a))[0];
  if (!lesson || covered.has(lesson.id) || keptIds.has(r.PuzzleId as string)) continue;
  const moves = (r.Moves ?? '').split(' ');
  if (moves.length < 2 || moves.length > 8) continue;
  const fen = r.FEN as string;
  const solver = turnOf(fen) === 'white' ? 'black' : 'white';
  const row: Row = {
    id: r.PuzzleId as string,
    fen,
    moves,
    rating,
    themes: (r.Themes ?? '').split(' ').filter(Boolean),
    lessonId: lesson.id,
    openingTags: tags,
    gameUrl: r.GameUrl as string,
    popularity: Number(r.Popularity),
    plays: Number(r.NbPlays),
    deviation: Number(r.RatingDeviation),
    solverMatches: solver === lesson.side,
  };
  if (row.popularity < 85 || row.plays < 300 || row.deviation > 90) continue;
  const list = candidates.get(lesson.id) ?? [];
  list.push(row);
  candidates.set(lesson.id, list);
}

const chosen: PuzzleData[] = [...kept];
for (const lesson of CATALOGUE.filter((l) => !covered.has(l.id))) {
  const rows = candidates.get(lesson.id) ?? [];
  for (let low = MIN_RATING; low < MAX_RATING; low += BUCKET) {
    const bucket = rows
      .filter((p) => p.rating >= low && p.rating < low + BUCKET)
      .sort((a, b) => Number(b.solverMatches) - Number(a.solverMatches) || b.plays - a.plays || a.id.localeCompare(b.id))
      .slice(0, PER_BUCKET);
    for (const { popularity: _p, plays: _n, deviation: _d, solverMatches: _s, ...p } of bucket) chosen.push(p);
  }
}

const out: PuzzleFile = {
  source: 'Lichess puzzle database (https://database.lichess.org/#puzzles)',
  licence: 'CC0 1.0',
  puzzles: chosen.sort((a, b) => a.lessonId.localeCompare(b.lessonId) || a.rating - b.rating),
};
const problems = validatePuzzles(out, Object.fromEntries(CATALOGUE.map((l) => [l.id, { tags: l.puzzleTags, themes: [] }])));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
writeFileSync(new URL('../data/puzzles.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
const perLesson = CATALOGUE.map((l) => `${l.id}: ${chosen.filter((p) => p.lessonId === l.id).length}`).join(', ');
console.error(`Wrote ${chosen.length} Puzzles to data/puzzles.json (${perLesson})`);
