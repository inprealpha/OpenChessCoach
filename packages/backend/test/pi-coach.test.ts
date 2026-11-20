import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { EngineQuestion } from '@chess-coach/shared/coach/engine-tool';
import {
  buildPiResourceLoaderOptions,
  buildPiToolAllowlist,
  PiCoach,
  type PiSessionLike,
  type PiSessionRequest,
} from '../src/coach/pi.ts';
import { CoachDeadlineError, CoachLimitError, CoachUnavailableError, type CoachEngine } from '../src/coach/port.ts';
import { PI_LOGIN_FIX } from '../src/pi-check.ts';

const BRIEF: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  recentMoves: '1. e4 e5 2. Nf3 Nc6',
  candidates: [],
  maxWords: 80,
  allowNote: false,
  hideMoves: false,
};

function fakePiSession(opts: {
  run: (
    emit: (ev: Record<string, unknown>) => void,
    req: PiSessionRequest,
  ) => Promise<string | undefined>;
  stats?: {
    cost?: number;
    assistantMessages?: number;
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
  onDispose?: () => void;
  onAbort?: () => void;
}): (req: PiSessionRequest) => Promise<PiSessionLike> {
  return async (req) => {
    let listener: ((ev: Record<string, unknown>) => void) | undefined;
    let lastText: string | undefined;
    return {
      subscribe(fn) {
        listener = fn as (ev: Record<string, unknown>) => void;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        lastText = await opts.run((ev) => listener?.(ev), req);
      },
      async abort() {
        opts.onAbort?.();
      },
      getLastAssistantText() {
        return lastText;
      },
      getSessionStats() {
        return opts.stats ?? {};
      },
      dispose() {
        opts.onDispose?.();
      },
    };
  };
}

describe('PiCoach', () => {
  it('streams prose without leaking the trailing JSON fence, parses structured fields, maps usage, and disposes the session', async () => {
    let disposed = false;
    const finalText =
      'Bb5 develops the bishop and puts pressure on c6.\n\n```json\n{"moves":["Bb5"],"arrows":[{"uci":"f1b5","brush":"green"}],"highlights":["c6"],"note":"Strong development."}\n```';

    const coach = new PiCoach({
      createSession: fakePiSession({
        async run(emit) {
          emit({ type: 'message_start' });
          for (const chunk of ['Bb5 develops ', 'the bishop and puts ', 'pressure on c6.\n\n`', '``json\n{"moves":["Bb5"]}\n```']) {
            emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: chunk } });
          }
          emit({ type: 'message_end' });
          return finalText;
        },
        stats: {
          cost: 0.002,
          assistantMessages: 1,
          tokens: { input: 200, output: 50, cacheRead: 20, cacheWrite: 5 },
        },
        onDispose: () => {
          disposed = true;
        },
      }),
      checkAuth: async () => ({ ok: true, providers: ['openai'], modelCount: 3 }),
    });

    const deltas: string[] = [];
    const reply = await coach.ask({ job: 'why', model: 'default', brief: BRIEF }, (d) => deltas.push(d));

    expect(coach.name).toBe('pi');
    expect(coach.provider).toBe('pi');
    expect(coach.supportsEngineTool).toBe(true);
    expect(disposed).toBe(true);
    expect(deltas.join('')).not.toContain('```');
    expect(deltas.join('').trim()).toBe('Bb5 develops the bishop and puts pressure on c6.');
    expect(reply.text).toBe('Bb5 develops the bishop and puts pressure on c6.');
    expect(reply.moves).toEqual(['Bb5']);
    expect(reply.arrows).toEqual([{ uci: 'f1b5', brush: 'green' }]);
    expect(reply.highlights).toEqual(['c6']);
    expect(reply.note).toBe('Strong development.');
    expect(reply.usage).toMatchObject({
      costUsd: 0.002,
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      turns: 1,
      models: ['pi'],
    });
  });

  it('wires Think deeper ask_engine custom tool and suppresses thinking-aloud before tool calls', async () => {
    const asked: EngineQuestion[] = [];
    const engine: CoachEngine = {
      maxQuestions: 2,
      maxCalls: 4,
      exhausted: false,
      async ask(q) {
        asked.push(q);
        return { text: 'After Bc4 Bc5 the position is +0.2.', refused: false };
      },
    };

    const coach = new PiCoach({
      createSession: fakePiSession({
        async run(emit, req) {
          expect(req.customTools).toHaveLength(1);
          const tool = req.customTools[0]!;
          expect(tool.name).toBe('ask_engine');

          // Turn 1: thinking aloud + tool call
          emit({ type: 'message_start' });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Let me check Bc4 first...' } });
          emit({ type: 'tool_execution_start' });
          const res = await tool.execute('call-1', { line: ['Bc4', 'Bc5'] }, undefined, undefined, {} as never);
          expect((res.content[0] as { text: string }).text).toContain('After Bc4 Bc5');
          emit({ type: 'message_end' });

          // Turn 2: final answer
          emit({ type: 'message_start' });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Bb5 puts more immediate pressure than Bc4.' } });
          emit({ type: 'message_end' });
          return 'Bb5 puts more immediate pressure than Bc4.';
        },
      }),
      checkAuth: async () => ({ ok: true, providers: ['openai'], modelCount: 1 }),
    });

    const deltas: string[] = [];
    const reply = await coach.ask({ job: 'why', model: 'default', brief: BRIEF, engine }, (d) => deltas.push(d));

    expect(asked).toEqual([{ line: ['Bc4', 'Bc5'] }]);
    expect(deltas.join('')).not.toContain('Let me check Bc4 first');
    expect(reply.text).toBe('Bb5 puts more immediate pressure than Bc4.');
  });

  it('enforces deadline and throws CoachDeadlineError when Engine tool call runs too long', async () => {
    let aborted = false;
    const engine: CoachEngine = {
      maxQuestions: 2,
      maxCalls: 4,
      exhausted: false,
      async ask() {
        return { text: 'ok', refused: false };
      },
    };
    const coach = new PiCoach({
      deadlineMs: 30,
      createSession: fakePiSession({
        async run() {
          await new Promise((r) => setTimeout(r, 100));
          return 'too late';
        },
        onAbort: () => {
          aborted = true;
        },
      }),
      checkAuth: async () => ({ ok: true, providers: ['openai'], modelCount: 1 }),
    });

    await expect(coach.ask({ job: 'why', model: 'default', brief: BRIEF, engine }, () => {})).rejects.toBeInstanceOf(CoachDeadlineError);
    expect(aborted).toBe(true);
  });

  it('maps auth errors to CoachUnavailableError and rate-limit errors to CoachLimitError', async () => {
    const authCoach = new PiCoach({
      createSession: fakePiSession({
        async run() {
          throw new Error('401 Unauthorized: invalid API key');
        },
      }),
      checkAuth: async () => ({ ok: false, code: 'not-logged-in', message: PI_LOGIN_FIX }),
    });
    await expect(authCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(CoachUnavailableError);
    const st = await authCoach.status();
    expect(st.state).toBe('unavailable');
    expect(st.provider).toBe('pi');

    const limitCoach = new PiCoach({
      createSession: fakePiSession({
        async run() {
          throw new Error('429 rate limit exceeded');
        },
      }),
      checkAuth: async () => ({ ok: true, providers: ['openai'], modelCount: 1 }),
    });
    await expect(limitCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(CoachLimitError);
  });

  it('captures assistant errorMessage reported on message_end when prompt resolves normally', async () => {
    const authCoach = new PiCoach({
      createSession: fakePiSession({
        async run(emit) {
          emit({ type: 'message_start' });
          emit({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized: expired token', content: [] },
          });
          return '';
        },
      }),
      checkAuth: async () => ({ ok: false, code: 'not-logged-in', message: PI_LOGIN_FIX }),
    });
    await expect(authCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(CoachUnavailableError);

    const limitCoach = new PiCoach({
      createSession: fakePiSession({
        async run(emit) {
          emit({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit exceeded', content: [] },
          });
          return '';
        },
      }),
      checkAuth: async () => ({ ok: true, providers: ['openai'], modelCount: 1 }),
    });
    await expect(limitCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(CoachLimitError);
  });

  it('builds isolated resource loader options and allowlists only custom tools', () => {
    const loaderOpts = buildPiResourceLoaderOptions('Chess Coach prompt');
    expect(loaderOpts).toMatchObject({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'Chess Coach prompt',
    });
    expect(buildPiToolAllowlist([])).toEqual([]);
    expect(buildPiToolAllowlist([{ name: 'ask_engine' } as never])).toEqual(['ask_engine']);
  });
});
