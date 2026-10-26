// Engine Games finished while the desktop was unreachable wait in IndexedDB and are sent when it
// is back. The desktop's database stays the single source of truth (ADR 0003).
import type { EngineGameRecord, GameSummary } from '@chess-coach/shared/protocol';
import { api } from './api.svelte.ts';
import { store } from './storage.ts';

const QUEUE = 'offlineQueue';

export async function queueEngineGame(game: EngineGameRecord): Promise<void> {
  const queue = (await store.get<EngineGameRecord[]>(QUEUE)) ?? [];
  if (!queue.some((g) => g.clientId === game.clientId)) queue.push(game);
  await store.set(QUEUE, queue);
}

export async function pendingGames(): Promise<EngineGameRecord[]> {
  return (await store.get<EngineGameRecord[]>(QUEUE)) ?? [];
}

let syncing = false;

export async function syncOfflineGames(): Promise<number> {
  if (syncing || api.state !== 'online') return 0;
  syncing = true;
  try {
    const queue = await pendingGames();
    if (!queue.length) return 0;
    const { saved } = await api.request('games.syncOffline', { games: queue });
    const done = new Set(queue.map((g) => g.clientId));
    const remaining = (await pendingGames()).filter((g) => !done.has(g.clientId));
    await store.set(QUEUE, remaining);
    return saved.length;
  } catch {
    return 0;
  } finally {
    syncing = false;
  }
}

/** Saves a finished Engine Game now, or queues it until the desktop is reachable. */
export async function saveFinishedEngineGame(game: EngineGameRecord): Promise<GameSummary | 'queued'> {
  if (api.state === 'online') {
    try {
      return (await api.request('games.saveEngineGame', { game })).game;
    } catch {
      // fall through to the queue
    }
  }
  await queueEngineGame(game);
  return 'queued';
}
