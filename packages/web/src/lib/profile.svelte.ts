// The Player Profile as last seen from the desktop, cached for offline use.
import type { PlayerProfile } from '@chess-coach/shared/protocol';
import { api } from './api.svelte.ts';
import { store } from './storage.ts';

class ProfileState {
  profile = $state<PlayerProfile | null>(null);
  loaded = $state(false);

  async load(): Promise<void> {
    try {
      // Keep the plain response: IndexedDB can't store the reactive copy in this.profile.
      const fresh = await api.request('profile.get', {});
      this.profile = fresh;
      await store.set('profile', fresh);
    } catch {
      this.profile ??= (await store.get<PlayerProfile>('profile')) ?? null;
    }
    this.loaded = true;
  }

  set(p: PlayerProfile): void {
    this.profile = p;
    void store.set('profile', p);
  }
}

export const profile = new ProfileState();
