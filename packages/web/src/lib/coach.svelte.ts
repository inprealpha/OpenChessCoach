// One conversation with the Coach on a board screen: streamed replies, follow-ups that share a
// thread, and the arrows of the latest reply.
import type { Arrow, CoachReply, CoachRequest } from '@chess-coach/shared/coach/types';
import { api, ApiError } from './api.svelte.ts';
import { randomId } from './random-id.ts';

export interface Entry {
  id: number;
  from: 'player' | 'coach';
  text: string;
  streaming: boolean;
  error?: boolean;
  note?: string | null;
  /** How many questions the Coach asked the Engine for this reply, with Think deeper on. */
  engineQuestions?: number;
  /** While it streams: what the Coach is doing meanwhile, such as asking the Engine. */
  status?: string;
}

let nextEntry = 1;

export class CoachThread {
  entries = $state<Entry[]>([]);
  arrows = $state<Arrow[]>([]);
  highlights = $state<string[]>([]);
  busy = $state(false);
  calls = $state(0);
  /** Whether the latest call failed, so a Why Question it carried was never answered. */
  failed = $state(false);
  threadId = randomId();

  reset(): void {
    this.entries = [];
    this.arrows = [];
    this.highlights = [];
    this.threadId = randomId();
  }

  clearAnnotations(): void {
    this.arrows = [];
    this.highlights = [];
  }

  /** Shows a line from the app itself in the conversation, with no Coach call. */
  say(text: string): void {
    this.entries = [...this.entries, { id: nextEntry++, from: 'coach', text, streaming: false }];
  }

  /** Shows why something the Player asked for failed, such as an error from the desktop's Engine. */
  sayError(err: unknown): void {
    const text = err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
    this.entries = [...this.entries, { id: nextEntry++, from: 'coach', text, streaming: false, error: true }];
  }

  /**
   * Asks the Coach. The desktop's Engine works out the facts from the position and move (ADR 0007).
   * If the call fails, the Player's words are taken back out of the conversation: they were never
   * answered, and the error shows in their place.
   */
  async ask(ask: CoachRequest, playerText?: string): Promise<CoachReply | undefined> {
    const said: Entry | undefined = playerText ? { id: nextEntry++, from: 'player', text: playerText, streaming: false } : undefined;
    if (said) this.entries = [...this.entries, said];
    const entry: Entry = { id: nextEntry++, from: 'coach', text: '', streaming: true };
    this.entries = [...this.entries, entry];
    const index = this.entries.length - 1;
    this.busy = true;
    this.failed = false;
    this.calls++;
    try {
      const reply = await api.request('coach.ask', { ...ask, threadId: this.threadId }, (text, _part, status) => {
        const current = this.entries[index];
        if (!current) return;
        // The answer's text replaces any status; a status shows only while no text has come.
        if (status !== undefined) this.entries[index] = { ...current, status };
        if (text) this.entries[index] = { ...current, text: current.text + text, status: '' };
      });
      this.entries[index] = { ...entry, text: reply.text, streaming: false, note: reply.note, engineQuestions: reply.engineQuestions };
      this.arrows = reply.arrows;
      this.highlights = reply.highlights;
      return reply;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The Coach couldn’t answer.';
      this.entries[index] = { ...entry, text: message, streaming: false, error: true };
      if (said) this.entries = this.entries.filter((e) => e.id !== said.id);
      this.failed = true;
      return undefined;
    } finally {
      this.busy = false;
    }
  }
}
