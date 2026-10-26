// The known state every verify-mode run starts from. `empty` is a fresh install, so the
// first-run screen shows; `default` is a Player who finished first run and imported one game;
// `many-games` is `default` with 60 newer games, more than one page of the game list.
import { SAMPLE_GAME_PGN } from '@chess-coach/shared/sample-game';
import { type FakeClock } from '../clock.ts';
import type { Db } from '../db.ts';
import { importPgn } from '../games.ts';
import { updateProfile } from '../profile.ts';

export { SEEDS, type Seed } from './runs.ts';
import type { Seed } from './runs.ts';

/** A real game from the Lichess database (CC0), the Player as White: the app's sample game. */
export const SEED_GAME_PGN = SAMPLE_GAME_PGN;

/** How many games `many-games` adds to `default`: more than one page of the game list. */
export const MANY_GAMES_EXTRA = 60;

/**
 * Short finished games for `many-games`, one a day from 2014-01-01, all newer than the seed game.
 * Each opens with its own pair of first moves, so no two are the same game.
 */
export function manyGamesPgns(count = MANY_GAMES_EXTRA): string[] {
  const firstMoves = ['e4', 'd4', 'c4', 'Nf3', 'g3', 'b3', 'f4', 'Nc3'];
  const replies = ['e5', 'd5', 'c5', 'Nf6', 'e6', 'c6', 'g6', 'd6'];
  const results = ['1-0', '0-1', '1/2-1/2'];
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(2014, 0, 1 + i)).toISOString().slice(0, 10).replaceAll('-', '.');
    const opponent = `sparring${String(i + 1).padStart(2, '0')}`;
    const [white, black] = i % 2 ? [opponent, 'bijean'] : ['bijean', opponent];
    const result = results[i % 3] as string;
    return `[Event "Casual game"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[UTCDate "${day}"]\n\n1. ${firstMoves[i % 8]} ${replies[Math.floor(i / 8) % 8]} ${result}\n`;
  });
}

export function seed(db: Db, clock: FakeClock, which: Seed): void {
  if (which === 'empty') return;
  updateProfile(db, { level: 'casual', goals: ['Learn a solid opening as White', 'Blunder less'], onboarded: true });
  importPgn(db, clock, SEED_GAME_PGN, 'white');
  if (which === 'many-games') {
    manyGamesPgns().forEach((pgn, i) => importPgn(db, clock, pgn, i % 2 ? 'black' : 'white'));
  }
}
