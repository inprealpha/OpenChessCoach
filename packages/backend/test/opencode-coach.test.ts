import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { AssistantMessage, Event, Part } from '@opencode-ai/sdk/v2';
import {
  OPENCODE_DISABLED_TOOLS,
  OPENCODE_ISOLATED_CONFIG,
  OpenCodeCoach,
  parseOpenCodeModel,
  type OpenCodeClientLike,
  type OpenCodeInstanceLike,
} from '../src/coach/opencode.ts';
import { CoachLimitError, CoachUnavailableError } from '../src/coach/port.ts';
import { checkOpenCode, isOpenCodeAuthError, isOpenCodeLimitError } from '../src/opencode-check.ts';

const BRIEF: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  recentMoves: '1. e4 e5 2. Nf3 Nc6',
  candidates: [{ san: 'Bb5', uci: 'f1b5', evaluation: '+0.30', grade: 'Best', line: 'Bb5 a6 Ba4' }],
  question: 'Why Bb5?',
  maxWords: 80,
  allowNote: false,
  hideMoves: false,
};

function makeAssistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'sess-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'user-1',
    modelID: 'big-pickle',
    providerID: 'opencode',
    mode: 'default',
    agent: 'default',
    path: { cwd: '/tmp', root: '/tmp' },
    cost: 0,
    tokens: {
      input: 120,
      output: 45,
      reasoning: 0,
      cache: { read: 10, write: 5 },
    },
    ...overrides,
  };
}

describe('checkOpenCode', () => {
  it('returns missing-cli when opencode binary is not found', async () => {
    const res = await checkOpenCode({
      findCli: async () => undefined,
      env: {},
      fileExists: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('missing-cli');
      expect(res.message).toMatch(/opencode\.ai\/install/i);
    }
  });

  it('detects env API key, auth.json, or free-model CLI-only setup', async () => {
    const envRes = await checkOpenCode({
      findCli: async () => '/usr/local/bin/opencode',
      env: { OPENCODE_API_KEY: 'sk-test' },
      fileExists: () => false,
    });
    expect(envRes).toEqual({ ok: true, path: '/usr/local/bin/opencode', authSource: 'env' });

    const authFileRes = await checkOpenCode({
      findCli: async () => '/usr/local/bin/opencode',
      env: {},
      homeDir: '/home/tester',
      fileExists: (p) => p.endsWith('/opencode/auth.json'),
    });
    expect(authFileRes).toEqual({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-auth' });

    // CLI installed with no API key or auth.json is still ready because OpenCode provides free Zen models.
    const cliOnlyRes = await checkOpenCode({
      findCli: async () => '/usr/local/bin/opencode',
      env: {},
      fileExists: () => false,
    });
    expect(cliOnlyRes).toEqual({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' });
  });

  it('classifies OpenCode auth and limit error messages', () => {
    expect(isOpenCodeAuthError('ProviderAuthError: Missing API key for provider')).toBe(true);
    expect(isOpenCodeAuthError('HTTP 401 Unauthorized')).toBe(true);
    expect(isOpenCodeAuthError('Random network timeout')).toBe(false);

    expect(isOpenCodeLimitError('HTTP 429 rate limit exceeded')).toBe(true);
    expect(isOpenCodeLimitError('Quota exhausted for free tier')).toBe(true);
    expect(isOpenCodeLimitError('Invalid JSON')).toBe(false);
  });
});

describe('parseOpenCodeModel', () => {
  it('parses provider/model, bare model, and default', () => {
    expect(parseOpenCodeModel('default')).toBeUndefined();
    expect(parseOpenCodeModel('   ')).toBeUndefined();
    expect(parseOpenCodeModel('opencode/big-pickle')).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    expect(parseOpenCodeModel('anthropic/claude-sonnet-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    });
    expect(parseOpenCodeModel('big-pickle')).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
  });
});

describe('OpenCodeCoach', () => {
  it('streams deltas, parses structured output, isolates tools/temp dir, and cleans up session', async () => {
    let createdDir: string | undefined;
    let passedConfig: unknown;
    let promptParams: Record<string, unknown> | undefined;
    const deletedSessions: string[] = [];
    const closeServer = vi.fn();

    async function* makeStream(): AsyncGenerator<Event, void, unknown> {
      yield {
        type: 'message.part.delta',
        properties: {
          sessionID: 'sess-1',
          messageID: 'msg-1',
          partID: 'part-1',
          field: 'text',
          delta: 'Bb5 develops ',
        },
      } as Event;
      yield {
        type: 'message.part.delta',
        properties: {
          sessionID: 'sess-1',
          messageID: 'msg-1',
          partID: 'part-1',
          field: 'text',
          delta: 'with tempo.',
        },
      } as Event;
      // Ignore deltas from unrelated sessions
      yield {
        type: 'message.part.delta',
        properties: {
          sessionID: 'other-session',
          messageID: 'msg-x',
          partID: 'part-x',
          field: 'text',
          delta: 'IGNORE ME',
        },
      } as Event;
    }

    const fakeClient: OpenCodeClientLike = {
      session: {
        async create(params) {
          createdDir = params.directory;
          expect(params.permission).toEqual([{ permission: '*', pattern: '*', action: 'deny' }]);
          return { data: { id: 'sess-1' } };
        },
        async prompt(params) {
          promptParams = params as Record<string, unknown>;
          return {
            data: {
              info: makeAssistantInfo({
                structured: {
                  text: 'Bb5 develops with tempo.',
                  moves: ['f1b5'],
                  arrows: [{ uci: 'f1b5', brush: 'green' }],
                  highlights: ['b5'],
                  note: null,
                },
              }),
              parts: [{ type: 'text', text: 'Bb5 develops with tempo.' } as Part],
            },
          };
        },
        async abort() {
          return {};
        },
        async delete(params) {
          deletedSessions.push(params.sessionID);
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: makeStream() };
        },
      },
    };

    const coach = new OpenCodeCoach({
      createInstance: async (opts) => {
        passedConfig = opts?.config;
        return { client: fakeClient, server: { url: 'http://127.0.0.1:12345', close: closeServer } } as OpenCodeInstanceLike;
      },
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    expect(coach.name).toBe('opencode');
    expect(coach.provider).toBe('opencode');
    expect(coach.supportsEngineTool).toBe(false);

    const deltas: string[] = [];
    const reply = await coach.ask(
      { job: 'why', model: 'opencode/big-pickle', brief: BRIEF },
      (d) => deltas.push(d),
    );

    expect(passedConfig).toEqual(OPENCODE_ISOLATED_CONFIG);
    expect(promptParams?.tools).toEqual(OPENCODE_DISABLED_TOOLS);
    expect(promptParams?.model).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    expect(deltas.join('')).toBe('Bb5 develops with tempo.');
    expect(reply.text).toBe('Bb5 develops with tempo.');
    expect(reply.moves).toEqual(['f1b5']);
    expect(reply.arrows).toEqual([{ uci: 'f1b5', brush: 'green' }]);
    expect(reply.highlights).toEqual(['b5']);
    expect(reply.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      turns: 1,
      models: ['opencode/big-pickle'],
    });
    expect(deletedSessions).toEqual(['sess-1']);
    expect(createdDir).toBeDefined();
    expect(existsSync(createdDir!)).toBe(false);

    coach.close();
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it('falls back to parsing JSON text when structured output is absent', async () => {
    const fakeClient: OpenCodeClientLike = {
      session: {
        async create() {
          return { data: { id: 'sess-2' } };
        },
        async prompt() {
          const jsonText = JSON.stringify({
            text: 'Bb5 pressures the knight on c6.',
            moves: ['f1b5'],
            arrows: [],
            highlights: ['c6'],
            note: null,
          });
          return {
            data: {
              info: makeAssistantInfo({ sessionID: 'sess-2' }),
              parts: [{ type: 'text', text: jsonText } as Part],
            },
          };
        },
        async abort() {
          return {};
        },
        async delete() {
          return {};
        },
      },
      event: {
        async subscribe() {
          return {
            stream: (async function* () {
              // no streaming events
            })(),
          };
        },
      },
    };

    const coach = new OpenCodeCoach({
      createInstance: async () => ({ client: fakeClient, server: { url: 'http://127.0.0.1:12345', close: () => {} } }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    const deltas: string[] = [];
    const reply = await coach.ask({ job: 'why', model: 'default', brief: BRIEF }, (d) => deltas.push(d));
    expect(reply.text).toBe('Bb5 pressures the knight on c6.');
    expect(reply.moves).toEqual(['f1b5']);
    expect(reply.highlights).toEqual(['c6']);
    expect(deltas.join('')).toBe('Bb5 pressures the knight on c6.');
  });

  it('maps ProviderAuthError to CoachUnavailableError and 429 rate-limit errors to CoachLimitError', async () => {
    const authClient: OpenCodeClientLike = {
      session: {
        async create() {
          return { data: { id: 'sess-auth' } };
        },
        async prompt() {
          return {
            data: {
              info: makeAssistantInfo({
                error: { name: 'ProviderAuthError', data: { providerID: 'openai', message: 'Missing API key' } },
              }),
              parts: [],
            },
          };
        },
        async abort() {
          return {};
        },
        async delete() {
          return {};
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };

    const authCoach = new OpenCodeCoach({
      createInstance: async () => ({ client: authClient, server: { url: 'http://127.0.0.1:12345', close: () => {} } }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(authCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(
      CoachUnavailableError,
    );
    const st = await authCoach.status();
    expect(st.state).toBe('unavailable');
    expect(st.provider).toBe('opencode');

    const limitClient: OpenCodeClientLike = {
      ...authClient,
      session: {
        ...authClient.session,
        async prompt() {
          return {
            data: {
              info: makeAssistantInfo({
                error: { name: 'APIError', data: { message: '429 rate limit exceeded', isRetryable: true } },
              }),
              parts: [],
            },
          };
        },
      },
    };

    const limitCoach = new OpenCodeCoach({
      createInstance: async () => ({ client: limitClient, server: { url: 'http://127.0.0.1:12345', close: () => {} } }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(limitCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(
      CoachLimitError,
    );
  });
});
