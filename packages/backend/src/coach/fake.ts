// The fake Coach for CI, tests and verify mode (ADR 0006). It replays recorded replies keyed
// by request, falls back to a deterministic reply built from the brief, and can be scripted to
// return any reply, including a move the Engine never suggested. The backend records every
// brief it receives in the coach_calls table.
import type { Brief, BriefCandidate } from '@chess-coach/shared/coach/brief';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { positionKey } from '@chess-coach/shared/chess';
import { CoachLimitError, CoachUnavailableError, type CoachCall, type CoachPort } from './port.ts';

export type ScriptedReply =
  | { kind: 'reply'; reply: Partial<CoachRawReply> }
  | { kind: 'limit' }
  | { kind: 'unavailable' };

export interface FakeCoachOptions {
  /** Recorded replies keyed by `recordingKey(brief)`. */
  recordings?: Record<string, CoachRawReply>;
  /** Milliseconds between streamed chunks. */
  chunkDelayMs?: number;
}

export function recordingKey(brief: Brief): string {
  return `${brief.job}|${positionKey(brief.fen)}|${brief.move?.uci ?? ''}`;
}

export class FakeCoach implements CoachPort {
  readonly name = 'fake' as const;
  private readonly recordings: Record<string, CoachRawReply>;
  private readonly chunkDelayMs: number;
  private readonly scripted: ScriptedReply[] = [];
  /** Every brief received, in order, and the model each call asked for. */
  readonly briefs: Brief[] = [];
  readonly models: string[] = [];

  get lastBrief(): Brief | undefined {
    return this.briefs.at(-1);
  }

  constructor(options: FakeCoachOptions = {}) {
    this.recordings = options.recordings ?? {};
    this.chunkDelayMs = options.chunkDelayMs ?? 5;
  }

  /** Queues a reply for the next call. */
  script(next: ScriptedReply): void {
    this.scripted.push(next);
  }

  clearScript(): void {
    this.scripted.length = 0;
  }

  async status(): Promise<CoachStatus> {
    return { state: 'ready' };
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    this.briefs.push(call.brief);
    this.models.push(call.model);
    const scripted = this.scripted.shift();
    // No reset time: the backend then assumes one from its own (possibly fake) clock.
    if (scripted?.kind === 'limit') throw new CoachLimitError('Your Claude usage limit has been reached.');
    if (scripted?.kind === 'unavailable') throw new CoachUnavailableError('Claude Code is not logged in on the desktop.');
    const base = this.recordings[recordingKey(call.brief)] ?? templateReply(call.brief);
    const reply: CoachRawReply = scripted?.kind === 'reply' ? { ...base, ...scripted.reply } : base;
    for (const chunk of chunks(reply.text)) {
      if (call.signal?.aborted) break;
      onText(chunk);
      if (this.chunkDelayMs) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
    }
    return reply;
  }
}

function chunks(text: string): string[] {
  const words = text.split(/(?<=\s)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out;
}

/** A deterministic reply that only uses moves from the brief, in the glossary's words. */
export function templateReply(brief: Brief): CoachRawReply {
  const best = brief.candidates[0];
  const alt = brief.candidates.find((c) => c.uci !== best?.uci && c.uci !== brief.move?.uci);
  const reply = brief.replies?.[0];
  const moves: string[] = [];
  const arrows: CoachRawReply['arrows'] = [];
  const add = (c: BriefCandidate | { uci: string } | undefined, brush: 'green' | 'blue' | 'red' | 'yellow') => {
    if (!c || moves.includes(c.uci)) return;
    moves.push(c.uci);
    arrows.push({ uci: c.uci, brush });
  };
  let text: string;
  switch (brief.job) {
    case 'hint':
      text = 'Look at which of your pieces is doing the least, and find the move that brings it into the game while keeping your king safe.';
      return { text, moves: [], arrows: [], highlights: [], note: null };
    case 'live': {
      text = `${brief.move?.san ?? 'That move'} is graded ${brief.move?.grade ?? 'Mistake'}. The Engine preferred ${best?.san ?? 'another move'}. You can take it back and try again.`;
      if (brief.move) add(brief.move, 'red');
      add(best, 'green');
      break;
    }
    case 'lesson-turn': {
      const popular = brief.lesson?.popularity ? ` Players at your level play: ${brief.lesson.popularity}.` : '';
      const grade = brief.move?.grade ?? 'Good';
      const verdict = grade === 'Best' || grade === 'Good' ? 'a sound choice' : 'not the best idea here';
      text = `What are your options here? You chose ${brief.move?.san ?? 'a move'}, graded ${grade}, which is ${verdict}. The Engine's top choice is ${best?.san ?? 'unclear'}.${popular}`;
      if (reply) text += ` Your opponent's main option next is ${reply.san}.`;
      text += grade === 'Best' || grade === 'Good' ? ' Let\'s continue the Lesson.' : ' Try another move.';
      add(best, 'green');
      if (brief.move && brief.move.uci !== best?.uci) add(brief.move, grade === 'Best' || grade === 'Good' ? 'blue' : 'red');
      add(reply, 'yellow');
      break;
    }
    case 'review-moment': {
      text = `Here you played ${brief.move?.san ?? 'a move'}, graded ${brief.move?.grade ?? 'Mistake'}. The Engine's better option was ${best?.san ?? 'another move'} (${best?.eval ?? ''}), which the Engine rates higher.`;
      if (alt) text += ` ${alt.san} was another option worth a look.`;
      if (brief.move) add(brief.move, 'red');
      add(best, 'green');
      add(alt, 'blue');
      break;
    }
    case 'why':
    default: {
      text = brief.move
        ? `${brief.move.san} is graded ${brief.move.grade}. The Engine's top choice was ${best?.san ?? 'another move'} (${best?.eval ?? ''}).`
        : `The Engine's top choice here is ${best?.san ?? 'unclear'} (${best?.eval ?? ''}).`;
      if (alt) text += ` ${alt.san} is graded ${alt.grade} because the Engine's line after it, ${alt.line || alt.san}, gives up some of the advantage.`;
      if (brief.question) text += ' That answers your Why Question.';
      add(best, 'green');
      if (brief.move && brief.move.uci !== best?.uci) add(brief.move, 'red');
      add(alt, 'blue');
      break;
    }
  }
  const note = brief.allowNote ? `Worked on ${brief.lesson?.opening ?? 'a Review'}.` : null;
  return { text, moves, arrows, highlights: [], note };
}
