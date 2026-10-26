// The Threat button's choice, remembered on the device, and the threat shown for a board's position.
// Off by default, so it never plays an Engine Game for the Player.
import type { Threat } from '@chess-coach/shared/threat';
import { store } from './storage.ts';

const KEY = 'showThreat';

class ThreatSetting {
  on = $state(false);
  private loaded: Promise<void> | undefined;
  private touched = false;

  load(): Promise<void> {
    this.loaded ??= store.get<boolean>(KEY).then((v) => {
      if (!this.touched) this.on = v === true;
    });
    return this.loaded;
  }

  toggle(): void {
    this.touched = true;
    this.on = !this.on;
    void store.set(KEY, this.on);
  }
}

export const threatSetting = new ThreatSetting();

/** The threat in the position a board shows, asked of an Engine whenever the position changes. */
export class ThreatView {
  threat = $state<Threat | null>(null);
  private fen: string | null = null;
  private readonly find: (fen: string) => Promise<Threat | undefined>;

  constructor(find: (fen: string) => Promise<Threat | undefined>) {
    this.find = find;
  }

  /** Shows the threat for this position, or none for null. An answer for a position no longer shown is dropped. */
  follow(fen: string | null): void {
    if (fen === this.fen) return;
    this.fen = fen;
    this.threat = null;
    if (!fen) return;
    this.find(fen).then(
      (t) => {
        if (this.fen === fen) this.threat = t ?? null;
      },
      // No threat arrow is better than an error: the board works without it.
      () => undefined,
    );
  }
}
