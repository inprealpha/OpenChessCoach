// Tools for writing a Lesson source (data/lesson-sources/<id>.json, ADR 0011): find positions in the
// CC0 Lichess puzzle database, ask the Engine about a position, and check a line before it goes into
// a source. `node data-prep/engine-check.ts <id>` is still the check that counts.
//
// Usage:
//   node data-prep/lesson-tools.ts puzzles <lichess_db_puzzle.csv[.zst]> [--themes=fork,pin] [--all-themes=a,b]
//        [--not-themes=x,y] [--rating=600-1200] [--max-pieces=12] [--min-plays=300] [--max-moves=6] [--opening=Italian_Game]
//        [--fen-has=K7] [--limit=20]
//     Puzzles matching every filter, most played first, with the position the Player sees (after the
//     opponent's set-up move), the solution in SAN and the puzzle's page. A part that uses one starts
//     from `start` and plays the solution, crediting `url`.
//   node data-prep/lesson-tools.ts analyse "<fen>" [--depth=14] [--lines=5]
//     The Engine's best lines in SAN, with scores from the side to move.
//   node data-prep/lesson-tools.ts check "<fen|start>" <white|black> "<SAN line>"
//     Plays the line and grades every move of the given side at depths 10 and 14, as the Engine
//     check does. Prints each Player move's Move Grades, and exits 1 if any is worse than Good.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { gradeFromAnalyses } from '@chess-coach/shared/analysis';
import { INITIAL_FEN, outcomeOf, piecesOf, playSan, playUci, sanLine, turnOf, type Side } from '@chess-coach/shared/chess';
import type { Score } from '@chess-coach/shared/engine';
import { createNodeEngine } from '../packages/backend/src/engine/node-engine.ts';

const [command, ...rest] = process.argv.slice(2);
const flags = new Map(rest.filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0] as string, a.split('=').slice(1).join('=')]));
const args = rest.filter((a) => !a.startsWith('--'));
const list = (name: string) => (flags.get(name) ?? '').split(',').filter(Boolean);
const score = (s: Score) => (s.mate !== undefined ? `M${s.mate}` : `${s.cp >= 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`);

async function puzzles(file: string): Promise<void> {
  const any = list('themes');
  const every = list('all-themes');
  const none = list('not-themes');
  const [low, high] = (flags.get('rating') ?? '0-3500').split('-').map(Number) as [number, number];
  const maxPieces = Number(flags.get('max-pieces') ?? 32);
  const minPlays = Number(flags.get('min-plays') ?? 300);
  const maxMoves = Number(flags.get('max-moves') ?? 8);
  const opening = flags.get('opening');
  const fenHas = flags.get('fen-has');
  const limit = Number(flags.get('limit') ?? 20);
  const input = file.endsWith('.zst') ? createReadStream(file).pipe(createZstdDecompress()) : createReadStream(file);
  const found: { plays: number; text: string }[] = [];
  let header: string[] | undefined;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const cols = line.split(',');
    if (!header) {
      header = cols;
      continue;
    }
    const r = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ''])) as Record<string, string>;
    const rating = Number(r.Rating);
    const plays = Number(r.NbPlays);
    if (rating < low || rating > high || plays < minPlays || Number(r.Popularity) < 80) continue;
    const themes = (r.Themes ?? '').split(' ');
    if (any.length && !any.some((t) => themes.includes(t))) continue;
    if (!every.every((t) => themes.includes(t)) || none.some((t) => themes.includes(t))) continue;
    if (opening && !(r.OpeningTags ?? '').split(' ').some((t) => t === opening || t.startsWith(`${opening}_`))) continue;
    const moves = (r.Moves ?? '').split(' ');
    if (moves.length > maxMoves + 1) continue;
    const setup = playUci(r.FEN as string, moves[0] as string);
    if (!setup) continue;
    if (piecesOf(setup.fenAfter).length > maxPieces) continue;
    if (fenHas && !setup.fenAfter.split(' ')[0]?.includes(fenHas)) continue;
    const solution = sanLine(setup.fenAfter, moves.slice(1)).join(' ');
    found.push({
      plays,
      text: [
        `https://lichess.org/training/${r.PuzzleId}  rating ${rating}  plays ${plays}  ${themes.join(' ')}`,
        `  opponent played ${setup.san} from ${r.FEN}`,
        `  start: ${setup.fenAfter}`,
        `  ${turnOf(setup.fenAfter)} to play: ${solution}`,
        `  game: ${r.GameUrl}`,
      ].join('\n'),
    });
  }
  found.sort((a, b) => b.plays - a.plays);
  console.log(found.slice(0, limit).map((f) => f.text).join('\n') || 'No puzzles match.');
  console.log(`(${found.length} matched)`);
}

async function analyse(fen: string): Promise<void> {
  const engine = await createNodeEngine(1);
  const a = await engine.analyse(fen, { multiPv: Number(flags.get('lines') ?? 5), depth: Number(flags.get('depth') ?? 14) });
  for (const l of a.lines) console.log(`${score(l.score).padStart(7)}  ${sanLine(fen, l.pv).join(' ')}`);
  engine.dispose();
}

async function check(start: string, side: Side, line: string): Promise<void> {
  const engine = await createNodeEngine(1);
  let fen = start === 'start' ? INITIAL_FEN : start;
  let failed = false;
  for (const [ply, san] of line.split(' ').filter(Boolean).entries()) {
    const played = playSan(fen, san);
    if (!played) {
      console.log(`${san}: not legal here (${fen})`);
      process.exit(1);
    }
    if (turnOf(fen) === side) {
      const grades: string[] = [];
      for (const depth of [10, 14]) {
        const options = { multiPv: 5, depth };
        const before = await engine.analyse(fen, options);
        const after = outcomeOf(played.fenAfter) ? undefined : await engine.analyse(played.fenAfter, options);
        const { grade } = gradeFromAnalyses(ply + 1, played.uci, before, after);
        if (grade !== 'Best' && grade !== 'Good') failed = true;
        grades.push(`${grade} at ${depth} (Engine: ${sanLine(fen, before.lines[0]?.pv.slice(0, 1) ?? [])[0]} ${score(before.lines[0]?.score as Score)})`);
      }
      console.log(`${String(ply).padStart(2)} ${san}: ${grades.join(', ')}`);
    } else console.log(`${String(ply).padStart(2)} ${san} (opponent)`);
    fen = played.fenAfter;
  }
  const end = outcomeOf(fen);
  console.log(`End: ${end ? `${end.reason}${end.winner ? `, ${end.winner} wins` : ''}` : fen}`);
  engine.dispose();
  process.exit(failed ? 1 : 0);
}

if (command === 'puzzles' && args[0]) await puzzles(args[0]);
else if (command === 'analyse' && args[0]) await analyse(args[0]);
else if (command === 'check' && args[0] && (args[1] === 'white' || args[1] === 'black') && args[2]) await check(args[0], args[1], args[2]);
else {
  console.error('Usage: see the comment at the top of data-prep/lesson-tools.ts');
  process.exit(1);
}
process.exit(0);
