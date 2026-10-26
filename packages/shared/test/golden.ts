// Loads the golden fixtures: real Lichess games (CC0) graded by Stockfish at verify mode's depth.
// Regenerate with: node scripts/golden-fixtures.ts
import { readFileSync } from 'node:fs';
import type { GradedMove } from '../src/analysis.ts';

export interface GoldenGame {
  site: string;
  opening: string;
  moves: GradedMove[];
}

export const golden = JSON.parse(readFileSync(new URL('./fixtures/graded-games.json', import.meta.url), 'utf8')) as { engine: string; games: GoldenGame[] };

export function game(id: string): GoldenGame {
  const g = golden.games.find((x) => x.site.endsWith(id));
  if (!g) throw new Error(`No golden game ${id}`);
  return g;
}

export const PGN_FIXTURES = readFileSync(new URL('./fixtures/lichess-games.pgn', import.meta.url), 'utf8');
