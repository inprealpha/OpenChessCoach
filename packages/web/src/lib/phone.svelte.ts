// Asking a desktop Player to pair their phone, where most people play chess: first run's first
// step and the main menu's reminder. A phone or tablet never asks. The desktop decides when to ask
// (`PhoneStatus.remind`); this keeps its answer and the QR code to show with it.
import type { PairingInfo } from '@chess-coach/shared/protocol';
import { api } from './api.svelte.ts';

class PhoneState {
  /** The QR code and whether to ask; null until loaded, and always on a phone or tablet. */
  info = $state<PairingInfo | null>(null);

  async load(): Promise<void> {
    try {
      this.info = await api.request('pairing.info', {});
    } catch {
      // Keep the last answer: asking again waits for the next connection.
    }
  }

  /** The Player put it off: the desktop asks again in a few days, or with `never`, not again. */
  async later(never = false): Promise<void> {
    try {
      const status = await api.request('pairing.remindLater', { never });
      if (this.info) this.info.phone = status;
    } catch {
      // The desktop went away: it asks again next time, which is no worse than "later".
    }
  }
}

export const phone = new PhoneState();
