// The game list this device keeps for when the desktop can't be reached: only the games the Player
// has been shown, with how many the desktop had.
import type { GameSummary } from '@chess-coach/shared/protocol';
import { store } from './storage.ts';

export interface KeptList {
  games: GameSummary[];
  total: number;
}

const KEY = 'games';

/** Keeps a list from the desktop. Pass plain arrays: IndexedDB can't store a reactive proxy. */
export async function keepGames(games: GameSummary[], total: number): Promise<void> {
  await store.set(KEY, { games, total } satisfies KeptList);
}

/** The list this device kept, or null when it kept none. */
export async function keptGames(): Promise<KeptList | null> {
  // Before the list came a page at a time, this device kept the whole list as a plain array.
  const kept = await store.get<KeptList | GameSummary[]>(KEY);
  if (!kept) return null;
  return Array.isArray(kept) ? { games: kept, total: kept.length } : kept;
}
