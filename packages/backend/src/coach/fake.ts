// The fake Coach for CI, tests and verify mode (ADR 0006). It replays recorded replies keyed
// by request, falls back to a deterministic reply built from the brief, and can be scripted to
// return any reply, including a move the Engine never suggested. With Think deeper on it asks the
// desktop's Engine one question, or the scripted ones (ADR 0010). It names a tempting move that
// fails, as the real Coach is told to (ADR 0011). The backend records every brief it receives in
// the coach_calls table.
import type { Brief, BriefCandidate } from '@chess-coach/shared/coach/brief';
import type { EngineAnswer, EngineQuestion } from '@chess-coach/shared/coach/engine-tool';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { positionKey, SIDE_NAMES } from '@chess-coach/shared/chess';
import { CoachDeadlineError, CoachLimitError, CoachUnavailableError, type CoachCall, type CoachPort } from './port.ts';

export type ScriptedReply =
  /** With Think deeper on, `questions` are what the fake Coach asks the Engine before it answers. */
  | { kind: 'reply'; reply: Partial<CoachRawReply>; questions?: EngineQuestion[] }
  /** The Coach fails, after asking the Engine `questions` first with Think deeper on. */
  | { kind: 'limit'; questions?: EngineQuestion[] }
  | { kind: 'unavailable'; questions?: EngineQuestion[] }
  /** With the Engine, the call runs into its deadline. */
  | { kind: 'deadline' };

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
  /** The deadline each call with the Engine was given, if any. */
  readonly deadlines: (number | undefined)[] = [];

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
    if (call.engine) this.deadlines.push(call.deadlineMs);
    const scripted = this.scripted.shift();
    if (call.engine && scripted && scripted.kind !== 'reply' && scripted.kind !== 'deadline') {
      for (const q of scripted.questions ?? []) await call.engine.ask(q);
    }
    if (scripted?.kind === 'deadline' && call.engine) throw new CoachDeadlineError(call.deadlineMs ?? 90_000);
    // No reset time: the backend then assumes one from its own (possibly fake) clock.
    if (scripted?.kind === 'limit') throw new CoachLimitError('Your Claude usage limit has been reached.');
    if (scripted?.kind === 'unavailable') throw new CoachUnavailableError('Claude Code is not logged in on the desktop.');
    let base = this.recordings[recordingKey(call.brief)] ?? templateReply(call.brief);
    if (call.engine) {
      const questions = (scripted?.kind === 'reply' ? scripted.questions : undefined) ?? defaultQuestions(call.brief);
      for (const q of questions) {
        const { text, refused } = await call.engine.ask(q);
        if (!refused) base = withAnswer(base, JSON.parse(text) as EngineAnswer);
      }
    }
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

/** The fake Coach's one question: what the Engine plays after its best move, so a reply names a move only the Engine's answer has. */
function defaultQuestions(brief: Brief): EngineQuestion[] {
  const best = brief.candidates[0];
  return best ? [{ line: [best.san] }] : [];
}

/** Adds what the Engine answered to a reply: the best move in the position asked about, named, not drawn. */
function withAnswer(reply: CoachRawReply, answer: EngineAnswer): CoachRawReply {
  const shown = answer.move ?? answer.candidates[0];
  if (!shown) return reply;
  const text = answer.move
    ? `${reply.text} I checked ${shown.san} with the Engine after ${answer.after}: it is graded ${shown.grade}.`
    : `${reply.text} I checked with the Engine: after ${answer.after}, its best move is ${shown.san}.`;
  return { ...reply, text, moves: reply.moves.includes(shown.uci) ? reply.moves : [...reply.moves, shown.uci] };
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
      text = brief.threat
        ? 'First see what your opponent threatens, and find the move that deals with it while keeping your pieces working.'
        : 'Look at which of your pieces is doing the least, and find the move that brings it into the game while keeping your king safe.';
      return { text, moves: [], arrows: [], highlights: [], note: null };
    case 'live': {
      text = `${brief.move?.san ?? 'That move'} is graded ${brief.move?.grade ?? 'Mistake'}.${chances(brief)} The Engine preferred ${best?.san ?? 'another move'}. You can take it back and try again.`;
      if (brief.move) add(brief.move, 'red');
      add(best, 'green');
      break;
    }
    case 'lesson-turn': {
      const popular = brief.lesson?.popularity ? ` Players at your level play: ${brief.lesson.popularity}.` : '';
      const grade = brief.move?.grade ?? 'Good';
      const sound = grade === 'Best' || grade === 'Good';
      if (brief.lesson?.isLessonMove === false) {
        // Not the Lesson's move: what it does and what it allows, and never the answer, which the
        // brief keeps back.
        text = `You chose ${brief.move?.san ?? 'a move'}, graded ${grade}: ${sound ? 'a sound move, but not the one this Lesson is teaching' : 'not the best idea here'}.${popular}`;
        if (brief.move?.does) text += ` It ${brief.move.does}.`;
        if (reply) text += ` Your opponent's main option next is ${reply.san}${reply.does ? `, which ${reply.does}` : ''}.`;
        const idea = brief.focus?.keyIdea;
        if (idea) text += ` Key idea: ${idea}${/[.!?…]$/.test(idea) ? '' : '.'}`;
        text += ' Try another move, or continue with the Lesson’s move.';
        if (brief.move) add(brief.move, sound ? 'blue' : 'red');
        add(reply, 'yellow');
        break;
      }
      const verdict = sound ? 'a sound choice' : 'not the best idea here';
      text = `What are your options here? You chose ${brief.move?.san ?? 'a move'}, graded ${grade}, which is ${verdict}.${chances(brief)} The Engine's top choice is ${best?.san ?? 'unclear'}.${popular}`;
      if (reply) text += ` Your opponent's main option next is ${reply.san}.`;
      // The Lesson's key idea, so journeys see the focus reached the Coach (ADR 0012).
      const idea = brief.focus?.keyIdea;
      if (idea) text += ` Key idea: ${idea}${/[.!?…]$/.test(idea) ? '' : '.'}`;
      text += grade === 'Best' || grade === 'Good' ? ' Let\'s continue the Lesson.' : ' Try another move.';
      add(best, 'green');
      if (brief.move && brief.move.uci !== best?.uci) add(brief.move, grade === 'Best' || grade === 'Good' ? 'blue' : 'red');
      add(reply, 'yellow');
      break;
    }
    case 'review-moment': {
      text = `Here you played ${brief.move?.san ?? 'a move'}, graded ${brief.move?.grade ?? 'Mistake'}.${chances(brief)} The Engine's better option was ${best?.san ?? 'another move'} (${best?.evaluation ?? ''}), which the Engine rates higher.`;
      if (alt) text += ` ${alt.san} was another option worth a look.`;
      if (brief.move) add(brief.move, 'red');
      add(best, 'green');
      add(alt, 'blue');
      break;
    }
    case 'why':
    default: {
      text = brief.move
        ? `${brief.move.san} is graded ${brief.move.grade}.${chances(brief)} The Engine's top choice was ${best?.san ?? 'another move'} (${best?.evaluation ?? ''}).`
        : `The Engine's top choice here is ${best?.san ?? 'unclear'} (${best?.evaluation ?? ''}).${chances(brief)}`;
      // A move the Player's question names takes the place of the other option, with the facts the brief gives for it.
      const asked = brief.candidates.find((c) => c.asked);
      if (asked) {
        text += ` You asked about ${asked.san}: it is graded ${asked.grade}.`;
        if (asked.does) text += ` It ${asked.does}.`;
        if (asked.result) text += ` In the Engine's line, ${asked.result}.`;
      } else if (alt) text += ` ${alt.san} is graded ${alt.grade} because the Engine's line after it, ${alt.line || alt.san}, gives up some of the advantage.`;
      if (brief.question) text += ' That answers your Why Question.';
      add(best, 'green');
      if (brief.move && brief.move.uci !== best?.uci) add(brief.move, 'red');
      // An asked move that is the Engine's best is already drawn in green, and the other option is drawn in its place.
      add(asked && asked.uci !== best?.uci ? asked : alt, 'blue');
      break;
    }
  }
  // The tempting moves (ADR 0011): the move itself, when many players reach for it, or the first
  // tempting move that fails, as a move many players would reach for here.
  if (brief.job === 'why' || brief.job === 'review-moment') {
    const trap = [...brief.candidates.filter((c) => c.tempting), ...(brief.tempting ?? [])].find(
      (t) => t.uci !== brief.move?.uci && t.grade !== 'Best' && t.grade !== 'Good',
    );
    if (brief.move?.tempting) text += ` Many players would reach for ${brief.move.san} here.`;
    else if (trap) {
      text += ` Many players would reach for ${trap.san} here, but it is graded ${trap.grade}.`;
      if (trap.does) text += ` It ${trap.does}.`;
      add(trap, 'red');
    }
  }
  // The threat, by the side that makes it: in the position, as the board's Threat arrow names
  // it, or after a move that left it on, as the Engine's best reply.
  if (brief.threat) {
    const side = SIDE_NAMES[brief.threat.by];
    text += brief.move
      ? ` ${brief.move.san} leaves ${side}'s threat ${brief.threat.san} on.`
      : ` Watch out: ${side} threatens ${brief.threat.san}.`;
    if (!moves.includes(brief.threat.uci)) moves.push(brief.threat.uci);
  }
  const note = brief.allowNote ? `Worked on ${brief.lesson?.opening ?? 'a Review'}.` : null;
  return { text, moves, arrows, highlights: [], note };
}

/** The brief's Winning Chances, word for word, as a key moment shows them. */
function chances(brief: Brief): string {
  const c = brief.winningChances;
  if (!c) return '';
  return c.after ? ` Before it, ${c.before}. After it, ${c.after}.` : ` ${c.before}.`;
}
