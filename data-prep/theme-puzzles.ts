// Picks the Puzzles for the theme and endgame Lessons from the CC0 Lichess puzzle database: each
// Lesson's Lichess themes, beginner-to-club ratings, spread across the rating range, leaving out the
// positions and games the Lessons already use. Re-runnable; writes data/theme-puzzles.json (ADR 0008).
//
// Usage: node data-prep/theme-puzzles.ts <lichess_db_puzzle.csv | lichess_db_puzzle.csv.zst> [--keep-existing]
// --keep-existing keeps the Puzzles already in data/theme-puzzles.json (those whose Lesson still has
// their theme and doesn't walk through them) and only picks them for Lessons that have none yet, so
// a Player's Puzzles don't change under them when Lessons are added.
// Source: https://database.lichess.org/#puzzles (the same columns as data-prep/puzzles.ts reads)
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import type { LessonData } from '@chess-coach/shared/content/lessons';
import { validatePuzzles, type PuzzleData, type PuzzleFile } from '@chess-coach/shared/content/puzzles';

const MIN_RATING = 600;
const MAX_RATING = 2000;
const BUCKET = 200;
const PER_BUCKET = 4;

const file = process.argv[2];
if (!file) {
  console.error('Usage: node data-prep/theme-puzzles.ts <lichess_db_puzzle.csv | .csv.zst>');
  process.exit(1);
}

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const index = read<{ id: string }[]>('../data/lessons/index.json');
const lessons = index.map((l) => read<LessonData>(`../data/lessons/${l.id}.json`)).filter((l) => l.puzzleThemes.length);
// The rarer theme decides first, so a fork that is also a skewer counts towards Skewers. The order is
// each theme's count among the database's popular puzzles rated 600 to 2000, rarest first.
const RARITY = [
  'bodenMate', 'doubleBishopMate', 'enPassant', 'dovetailMate', 'arabianMate', 'anastasiaMate', 'hookMate', 'interference',
  'smotheredMate', 'doubleCheck', 'knightEndgame', 'zugzwang', 'capturingDefender', 'clearance', 'bishopEndgame', 'intermezzo',
  'trappedPiece', 'discoveredCheck', 'backRankMate', 'quietMove', 'promotion', 'skewer', 'pawnEndgame', 'exposedKing',
  'hangingPiece', 'defensiveMove', 'attraction', 'deflection', 'rookEndgame', 'discoveredAttack', 'advancedPawn', 'pin',
  'sacrifice', 'kingsideAttack', 'mateIn1', 'mateIn2', 'fork',
];
const order = [...lessons].sort((a, b) => themeRank(a) - themeRank(b));
function themeRank(l: LessonData): number {
  return Math.min(...l.puzzleThemes.map((t) => (RARITY.includes(t) ? RARITY.indexOf(t) : RARITY.length)));
}
// Positions a Lesson already walks through, Puzzles from a game a Lesson uses, and the opening
// Puzzles are not picked again.
const urls = lessons.flatMap((l) => l.parts.map((p) => p.credit.url));
const used = new Set([
  ...urls.map((u) => u.match(/lichess\.org\/training\/(\w+)$/)?.[1]).filter(Boolean),
  ...read<PuzzleFile>('../data/puzzles.json').puzzles.map((p) => p.id),
]);
const usedGames = new Set(urls.map((u) => u.match(/^https:\/\/lichess\.org\/(\w{8})(#\d+)?$/)?.[1]).filter(Boolean));
const gameOf = (url: string) => url.match(/lichess\.org\/(\w{8})/)?.[1];
const fresh = (p: { id: string; gameUrl: string }) => !used.has(p.id) && !usedGames.has(gameOf(p.gameUrl));
const kept: PuzzleData[] = process.argv.includes('--keep-existing')
  ? read<PuzzleFile>('../data/theme-puzzles.json').puzzles.filter(
      (p) => fresh(p) && lessons.find((l) => l.id === p.lessonId)?.puzzleThemes.some((t) => p.themes.includes(t)),
    )
  : [];
const covered = new Set(kept.map((p) => p.lessonId));
for (const p of kept) used.add(p.id);

interface Row extends PuzzleData {
  popularity: number;
  plays: number;
  deviation: number;
}

const candidates = new Map<string, Row[]>();
const seen = new Set<string>();
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
  const id = r.PuzzleId as string;
  if (seen.has(id) || !fresh({ id, gameUrl: r.GameUrl ?? '' })) continue;
  seen.add(id);
  const rating = Number(r.Rating);
  if (rating < MIN_RATING || rating > MAX_RATING) continue;
  const themes = (r.Themes ?? '').split(' ').filter(Boolean);
  const lesson = order.find((l) => l.puzzleThemes.some((t) => themes.includes(t)));
  if (!lesson || covered.has(lesson.id)) continue;
  const moves = (r.Moves ?? '').split(' ');
  if (moves.length < 2 || moves.length > 8) continue;
  const row: Row = {
    id,
    fen: r.FEN as string,
    moves,
    rating,
    themes,
    lessonId: lesson.id,
    openingTags: (r.OpeningTags ?? '').split(' ').filter(Boolean),
    gameUrl: r.GameUrl as string,
    popularity: Number(r.Popularity),
    plays: Number(r.NbPlays),
    deviation: Number(r.RatingDeviation),
  };
  if (row.popularity < 85 || row.plays < 300 || row.deviation > 90) continue;
  const list = candidates.get(lesson.id) ?? [];
  list.push(row);
  candidates.set(lesson.id, list);
}

const chosen: PuzzleData[] = [...kept];
for (const lesson of lessons.filter((l) => !covered.has(l.id))) {
  const rows = candidates.get(lesson.id) ?? [];
  for (let low = MIN_RATING; low < MAX_RATING; low += BUCKET) {
    const bucket = rows
      .filter((p) => p.rating >= low && p.rating < low + BUCKET)
      .sort((a, b) => b.plays - a.plays || a.id.localeCompare(b.id))
      .slice(0, PER_BUCKET);
    for (const { popularity: _p, plays: _n, deviation: _d, ...p } of bucket) chosen.push(p);
  }
}

const out: PuzzleFile = {
  source: 'Lichess puzzle database (https://database.lichess.org/#puzzles)',
  licence: 'CC0 1.0',
  puzzles: chosen.sort((a, b) => a.lessonId.localeCompare(b.lessonId) || a.rating - b.rating),
};
const problems = validatePuzzles(out, Object.fromEntries(lessons.map((l) => [l.id, { tags: l.puzzleTags, themes: l.puzzleThemes }])));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
writeFileSync(new URL('../data/theme-puzzles.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
const perLesson = lessons.map((l) => `${l.id}: ${chosen.filter((p) => p.lessonId === l.id).length}`).join(', ');
console.error(`Wrote ${chosen.length} Puzzles to data/theme-puzzles.json (${perLesson})`);
