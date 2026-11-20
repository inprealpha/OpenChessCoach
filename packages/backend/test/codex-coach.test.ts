import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import { CodexCoach, type CodexClientLike, type CodexThreadLike } from '../src/coach/codex.ts';
import { CoachLimitError, CoachUnavailableError } from '../src/coach/port.ts';
import { checkCodex, CODEX_LOGIN_FIX } from '../src/codex-check.ts';

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

function mockCodex(
  events: Array<Record<string, unknown>>,
  capture?: { threadOptions?: Record<string, unknown>; turnOptions?: Record<string, unknown>; prompt?: unknown },
): () => CodexClientLike {
  return () => ({
    startThread(threadOptions) {
      if (capture) capture.threadOptions = threadOptions as Record<string, unknown>;
      const thread: CodexThreadLike = {
        async runStreamed(input, turnOptions) {
          if (capture) {
            capture.prompt = input;
            capture.turnOptions = turnOptions as Record<string, unknown>;
          }
          async function* stream() {
            for (const ev of events) yield ev;
          }
          return { events: stream() as AsyncGenerator<never> };
        },
      };
      return thread;
    },
  });
}

describe('CodexCoach', () => {
  it('streams deduplicated text deltas, parses structured JSON, enforces safe sandbox options, and maps usage', async () => {
    const capture: { threadOptions?: Record<string, unknown>; turnOptions?: Record<string, unknown>; prompt?: unknown } = {};
    const finalJson = JSON.stringify({
      text: 'Bb5 develops cleanly and pressures c6.',
      moves: ['Bb5', 'Bc4'],
      arrows: [{ uci: 'f1b5', brush: 'green' }],
      highlights: ['c6'],
      note: 'Good opening pressure.',
    });

    const coach = new CodexCoach({
      createClient: mockCodex(
        [
          { type: 'item.updated', item: { type: 'agent_message', text: '{"text":"Bb5 develops' } },
          { type: 'item.updated', item: { type: 'agent_message', text: '{"text":"Bb5 develops cleanly' } },
          { type: 'item.completed', item: { type: 'agent_message', text: finalJson } },
          {
            type: 'turn.completed',
            usage: { input_tokens: 120, output_tokens: 45, cached_input_tokens: 30, cache_write_input_tokens: 10 },
          },
        ],
        capture,
      ),
      checkAuth: async () => ({ ok: true, path: '/usr/bin/codex', authSource: 'codex-auth' }),
    });

    const deltas: string[] = [];
    const reply = await coach.ask({ job: 'why', model: 'gpt-5.4-mini', brief: BRIEF }, (d) => deltas.push(d));

    expect(coach.name).toBe('codex');
    expect(coach.provider).toBe('codex');
    expect(coach.supportsEngineTool).toBe(false);
    expect(deltas.join('')).toBe('Bb5 develops cleanly and pressures c6.');
    expect(reply.text).toBe('Bb5 develops cleanly and pressures c6.');
    expect(reply.moves).toEqual(['Bb5', 'Bc4']);
    expect(reply.arrows).toEqual([{ uci: 'f1b5', brush: 'green' }]);
    expect(reply.highlights).toEqual(['c6']);
    expect(reply.note).toBe('Good opening pressure.');
    expect(reply.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      turns: 1,
      models: ['gpt-5.4-mini'],
    });

    // Safe read-only sandbox options
    expect(capture.threadOptions).toMatchObject({
      model: 'gpt-5.4-mini',
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
    });
    expect(capture.turnOptions?.outputSchema).toBeDefined();
  });

  it('omits model option when model is default and forwards abort signal', async () => {
    const capture: { threadOptions?: Record<string, unknown>; turnOptions?: Record<string, unknown> } = {};
    const ac = new AbortController();
    const coach = new CodexCoach({
      createClient: mockCodex(
        [{ type: 'item.completed', item: { type: 'agent_message', text: '{"text":"Solid move."}' } }],
        capture,
      ),
      checkAuth: async () => ({ ok: true, path: '/usr/bin/codex', authSource: 'env' }),
    });

    const reply = await coach.ask({ job: 'why', model: 'default', brief: BRIEF, signal: ac.signal }, () => {});
    expect(reply.text).toBe('Solid move.');
    expect(capture.threadOptions?.model).toBeUndefined();
    expect(capture.turnOptions?.signal).toBe(ac.signal);
  });

  it('maps auth failures to CoachUnavailableError and updates status()', async () => {
    const coach = new CodexCoach({
      createClient: mockCodex([{ type: 'turn.failed', error: { message: '401 Unauthorized: token expired' } }]),
      checkAuth: async () => ({ ok: false, code: 'not-logged-in', message: CODEX_LOGIN_FIX }),
    });

    await expect(coach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(CoachUnavailableError);
    const st = await coach.status();
    expect(st.state).toBe('unavailable');
    expect(st.provider).toBe('codex');
    expect(st.reason).toContain('codex login');
  });

  it('maps rate-limit errors to CoachLimitError', async () => {
    const coach = new CodexCoach({
      createClient: mockCodex([{ type: 'turn.failed', error: { message: 'Rate limit exceeded (429)' } }]),
      checkAuth: async () => ({ ok: true, path: '/usr/bin/codex', authSource: 'codex-auth' }),
    });

    await expect(coach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(CoachLimitError);
  });
});

describe('checkCodex', () => {
  it('reports not-logged-in with install instructions when codex binary and auth are missing', async () => {
    const res = await checkCodex({ findCli: async () => undefined, env: {}, fileExists: () => false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not-logged-in');
      expect(res.message).toContain('codex login');
    }
  });

  it('reports ok with env authSource when OPENAI_API_KEY is set', async () => {
    const res = await checkCodex({ findCli: async () => '/usr/bin/codex', env: { OPENAI_API_KEY: 'sk-test' } });
    expect(res).toEqual({ ok: true, path: '/usr/bin/codex', authSource: 'env' });
  });

  it('reports ok with codex-auth when auth.json has a valid access token', async () => {
    const res = await checkCodex({
      findCli: async () => '/usr/bin/codex',
      env: {},
      fileExists: () => true,
      readFile: () => JSON.stringify({ tokens: { access_token: 'tok-123' } }),
    });
    expect(res).toEqual({ ok: true, path: '/usr/bin/codex', authSource: 'codex-auth' });
  });

  it('reports not-logged-in when no env key and no auth.json exists', async () => {
    const res = await checkCodex({
      findCli: async () => '/usr/bin/codex',
      env: {},
      fileExists: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not-logged-in');
      expect(res.message).toContain('codex login');
    }
  });
});
