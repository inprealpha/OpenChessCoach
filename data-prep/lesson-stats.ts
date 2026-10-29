// Counts which moves players choose in every main-line position of the Lesson catalogue, by
// rating band, from Lichess database dumps (CC0). The dumps are tens of GB, so this streams and
// keeps only the counts. Re-runnable; writes data/lesson-stats.json.
//
// Usage: node data-prep/lesson-stats.ts <dump.pgn | dump.pgn.zst> [more dumps...]
// Dumps: https://database.lichess.org/ (lichess_db_standard_rated_YYYY-MM.pgn.zst)
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { INITIAL_FEN, playSan, playUci, positionKey } from '@chess-coach/shared/chess';
import type { PlayerLevel } from '@chess-coach/shared/protocol';
import { readSources } from './sources.ts';

const MAX_PLIES = 24;
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node data-prep/lesson-stats.ts <dump.pgn | dump.pgn.zst> [more dumps...]');
  process.exit(1);
}

// Every position on a main line, keyed without move counters so transpositions count.
const targets = new Set<string>();
for (const lesson of [...readSources().values()].filter((s) => s.kind === 'opening')) {
  let fen = INITIAL_FEN;
  targets.add(positionKey(fen));
  for (const san of lesson.parts[0]?.line.split(' ') ?? []) {
    const played = playSan(fen, san);
    if (!played) throw new Error(`${lesson.id}: illegal ${san}`);
    fen = played.fenAfter;
    targets.add(positionKey(fen));
  }
}

type Counts = Record<string, Record<PlayerLevel, Record<string, number>>>;
const counts: Counts = {};

function band(rating: number): PlayerLevel {
  if (rating < 1400) return 'beginner';
  if (rating < 1800) return 'casual';
  return 'club';
}

function record(headers: Record<string, string>, movetext: string): void {
  const white = Number(headers.WhiteElo);
  const black = Number(headers.BlackElo);
  if (!white || !black) return;
  if ((headers.Event ?? '').includes('Bullet')) return;
  const tokens = movetext.replace(/\{[^}]*\}/g, ' ').replace(/\([^)]*\)/g, ' ').split(/\s+/);
  let fen = INITIAL_FEN;
  let ply = 0;
  for (const token of tokens) {
    if (!token || /^\d+\.+$/.test(token) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue;
    const key = positionKey(fen);
    if (!targets.has(key) || ply >= MAX_PLIES) return;
    const san = token.replace(/^\d+\.+/, '').replace(/[?!]+$/, '');
    const played = playSan(fen, san);
    if (!played) return;
    const mover = ply % 2 === 0 ? white : black;
    const byBand = (counts[key] ??= { beginner: {}, casual: {}, club: {} });
    const b = byBand[band(mover)];
    b[played.uci] = (b[played.uci] ?? 0) + 1;
    fen = played.fenAfter;
    ply++;
  }
}

let games = 0;
for (const file of files) {
  const input = file.endsWith('.zst') ? createReadStream(file).pipe(createZstdDecompress()) : createReadStream(file);
  const rl = createInterface({ input, crlfDelay: Infinity });
  let headers: Record<string, string> = {};
  let movetext = '';
  for await (const line of rl) {
    if (line.startsWith('[')) {
      if (movetext) {
        record(headers, movetext);
        games++;
        headers = {};
        movetext = '';
      }
      const m = line.match(/^\[(\w+) "(.*)"\]$/);
      if (m) headers[m[1] as string] = m[2] as string;
    } else if (line.trim()) movetext += ` ${line}`;
    if (games % 200_000 === 0 && movetext === '' && games) process.stderr.write(`  ${games} games…\r`);
  }
  if (movetext) {
    record(headers, movetext);
    games++;
  }
}

// Keep the counts compact: moves with at least 0.5% share in their band.
const out: Record<string, Record<PlayerLevel, { total: number; moves: { uci: string; games: number }[] }>> = {};
for (const [key, byBand] of Object.entries(counts)) {
  out[key] = { beginner: { total: 0, moves: [] }, casual: { total: 0, moves: [] }, club: { total: 0, moves: [] } };
  for (const level of ['beginner', 'casual', 'club'] as const) {
    const entries = Object.entries(byBand[level]);
    const total = entries.reduce((n, [, c]) => n + c, 0);
    const moves = entries
      .filter(([uci, c]) => c / total >= 0.005 && playUci(`${key} 0 1`, uci))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([uci, c]) => ({ uci, games: c }));
    out[key][level] = { total, moves };
  }
}
const target = new URL('../data/lesson-stats.json', import.meta.url);
writeFileSync(
  target,
  `${JSON.stringify({ source: files.map((f) => f.split('/').pop()).join(', '), games, positions: out }, null, 1)}\n`,
);
console.error(`\nCounted ${games} games; wrote statistics for ${Object.keys(out).length} positions to data/lesson-stats.json`);
