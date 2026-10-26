// Builds data/openings.json from Lichess's chess-openings TSVs (CC0).
// Usage: node data-prep/openings.ts [--from <folder with a.tsv..e.tsv>]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INITIAL_FEN, playSan } from '@chess-coach/shared/chess';

const SOURCE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';
const fromIndex = process.argv.indexOf('--from');
const from = fromIndex > 0 ? process.argv[fromIndex + 1] : undefined;

export interface OpeningEntry {
  eco: string;
  name: string;
  /** Moves in UCI, space-separated. */
  uci: string;
}

async function load(file: string): Promise<string> {
  if (from) return readFileSync(join(from, file), 'utf8');
  const res = await fetch(`${SOURCE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.text();
}

const out: OpeningEntry[] = [];
for (const file of ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv']) {
  const lines = (await load(file)).trim().split('\n').slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !name || !pgn) continue;
    let fen = INITIAL_FEN;
    const ucis: string[] = [];
    for (const token of pgn.split(/\s+/)) {
      if (/^\d+\.+$/.test(token) || !token) continue;
      const played = playSan(fen, token.replace(/^\d+\.+/, ''));
      if (!played) throw new Error(`Illegal move ${token} in ${name}`);
      ucis.push(played.uci);
      fen = played.fenAfter;
    }
    out.push({ eco, name, uci: ucis.join(' ') });
  }
}
out.sort((a, b) => a.uci.localeCompare(b.uci));
const target = new URL('../data/openings.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(out)}\n`);
console.log(`Wrote ${out.length} openings to data/openings.json`);
