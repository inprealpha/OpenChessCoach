import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { AssistantMessage, Event, Part } from '@opencode-ai/sdk/v2';
import {
  OPENCODE_ISOLATED_CONFIG,
  OpenCodeCoach,
  parseOpenCodeModel,
  parseOpenCodeServerBanner,
  type OpenCodeClientLike,
  type OpenCodeInstanceLike,
  type OpenCodeV2ClientLike,
  type OpenCodeV2Event,
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
      fileExists: (p) => p.replaceAll('\\', '/').endsWith('/opencode/auth.json'),
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
    expect(isOpenCodeLimitError('provider.free-limit: Free usage limit reached')).toBe(true);
    expect(isOpenCodeLimitError('Invalid JSON')).toBe(false);
  });
});

describe('parseOpenCodeServerBanner', () => {
  it('detects both v1 and v2 opencode serve stdout banners', () => {
    expect(parseOpenCodeServerBanner('opencode server listening on http://127.0.0.1:41234\n')).toEqual({
      apiVersion: 'v1',
      url: 'http://127.0.0.1:41234',
    });
    expect(parseOpenCodeServerBanner('server listening on http://127.0.0.1:41234\n')).toBeUndefined();
    expect(
      parseOpenCodeServerBanner('server listening on http://127.0.0.1:41234\nserver password secret-pw\n'),
    ).toEqual({
      apiVersion: 'v2',
      url: 'http://127.0.0.1:41234',
      password: 'secret-pw',
    });
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
          expect(params.permission).toEqual([{ permission: '*', pattern: '*', action: 'ask' }]);
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
    expect(promptParams?.tools).toBeUndefined();
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

  it('rejects permission.asked and aborts the session before any tool can execute on v1', async () => {
    const rejected: Array<{ requestID: string; reply: string }> = [];
    const aborted: string[] = [];
    let unblockPrompt!: () => void;

    async function* makeStream(): AsyncGenerator<Event, void, unknown> {
      yield {
        type: 'permission.asked',
        properties: {
          id: 'per-1',
          sessionID: 'sess-perm',
          permission: 'bash',
          patterns: ['echo pwned'],
          metadata: {},
          always: [],
        },
      } as unknown as Event;
    }

    const fakeClient: OpenCodeClientLike = {
      session: {
        async create() {
          return { data: { id: 'sess-perm' } };
        },
        async prompt(_params, opts) {
          await new Promise<void>((resolve, reject) => {
            unblockPrompt = resolve;
            if (opts?.signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
          return { data: { info: makeAssistantInfo(), parts: [] } };
        },
        async abort(params) {
          aborted.push(params.sessionID);
          return {};
        },
        async delete() {
          return {};
        },
      },
      permission: {
        async reply(params) {
          rejected.push({ requestID: params.requestID, reply: params.reply });
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
      createInstance: async () =>
        ({ client: fakeClient, server: { url: 'http://127.0.0.1:12345', close: vi.fn() } }) as OpenCodeInstanceLike,
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(coach.ask({ job: 'why', model: 'opencode/deepseek-v4.1-flash-free', brief: BRIEF }, () => {})).rejects.toThrow(
      /unexpected tool call \(bash\)/i,
    );
    unblockPrompt?.();
    expect(rejected).toEqual([{ requestID: 'per-1', reply: 'reject' }]);
    expect(aborted).toContain('sess-perm');
  });

  it('fails fast with CoachLimitError when v1 enters a free_tier_limit retry loop', async () => {
    const aborted: string[] = [];

    async function* makeStream(): AsyncGenerator<Event, void, unknown> {
      yield {
        type: 'session.status',
        properties: {
          sessionID: 'sess-retry',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Free usage exceeded, subscribe to Go',
            next: Date.now() + 60_000,
          },
        },
      } as unknown as Event;
    }

    const fakeClient: OpenCodeClientLike = {
      session: {
        async create() {
          return { data: { id: 'sess-retry' } };
        },
        async prompt(_params, opts) {
          await new Promise<void>((_resolve, reject) => {
            if (opts?.signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
          return { data: { info: makeAssistantInfo(), parts: [] } };
        },
        async abort(params) {
          aborted.push(params.sessionID);
          return {};
        },
        async delete() {
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
      createInstance: async () =>
        ({ client: fakeClient, server: { url: 'http://127.0.0.1:12345', close: vi.fn() } }) as OpenCodeInstanceLike,
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(coach.ask({ job: 'why', model: 'opencode/deepseek-v4.1-flash-free', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(
      CoachLimitError,
    );
    expect(aborted).toContain('sess-retry');
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

  it('allows OpenCode v1 StructuredOutput tool parts while still rejecting other tools', async () => {
    const structuredToolPart = {
      id: 'part-structured',
      sessionID: 'sess-structured',
      messageID: 'msg-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'StructuredOutput',
    } as unknown as Part;

    const structuredClient: OpenCodeClientLike = {
      session: {
        async create() {
          return { data: { id: 'sess-structured' } };
        },
        async prompt() {
          return {
            data: {
              info: makeAssistantInfo({
                sessionID: 'sess-structured',
                structured: {
                  text: 'Bb5 develops with tempo against the c6 knight.',
                  moves: ['f1b5'],
                  arrows: [],
                  highlights: ['c6'],
                  note: null,
                },
              }),
              parts: [structuredToolPart],
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
              yield {
                type: 'message.part.updated',
                properties: { part: structuredToolPart },
              } as Event;
            })(),
          };
        },
      },
    };

    const structuredCoach = new OpenCodeCoach({
      createInstance: async () => ({
        client: structuredClient,
        server: { url: 'http://127.0.0.1:12345', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    const reply = await structuredCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {});
    expect(reply.text).toBe('Bb5 develops with tempo against the c6 knight.');
    expect(reply.moves).toEqual(['f1b5']);

    const bashToolPart = { ...structuredToolPart, tool: 'bash' } as unknown as Part;
    const bashClient: OpenCodeClientLike = {
      ...structuredClient,
      session: {
        ...structuredClient.session,
        async prompt() {
          return {
            data: {
              info: makeAssistantInfo({ sessionID: 'sess-structured' }),
              parts: [bashToolPart],
            },
          };
        },
      },
      event: {
        async subscribe() {
          return { stream: (async function* () {})() };
        },
      },
    };

    const bashCoach = new OpenCodeCoach({
      createInstance: async () => ({
        client: bashClient,
        server: { url: 'http://127.0.0.1:12345', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(bashCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toThrow(
      /unexpected tool call \(bash\)/i,
    );
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

    let authOk = false;
    const authCoach = new OpenCodeCoach({
      createInstance: async () => ({ client: authClient, server: { url: 'http://127.0.0.1:12345', close: () => {} } }),
      checkAuth: async () =>
        authOk
          ? { ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }
          : { ok: false, code: 'missing-cli', message: 'OpenCode CLI not found.' },
    });

    await expect(authCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toBeInstanceOf(
      CoachUnavailableError,
    );
    const st = await authCoach.status();
    expect(st.state).toBe('unavailable');
    expect(st.provider).toBe('opencode');

    // Once auth/CLI is repaired or the user switches models, status() clears the stale lockout instead of wedging forever.
    authOk = true;
    const recovered = await authCoach.status();
    expect(recovered).toEqual({ state: 'ready', provider: 'opencode' });

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

  it('supports OpenCode v2 HTTP+SSE streaming without leaking the JSON fence, parses structured output, and cleans up', async () => {
    let createdDir: string | undefined;
    let deletedSession: string | undefined;

    async function* makeV2Events(): AsyncGenerator<OpenCodeV2Event, void, unknown> {
      yield {
        type: 'session.step.started',
        data: { sessionID: 'ses-v2', model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' } },
      };
      yield {
        type: 'session.text.delta',
        data: { sessionID: 'ses-v2', delta: 'Bb5 pressures ' },
      };
      yield {
        type: 'session.text.delta',
        data: {
          sessionID: 'ses-v2',
          delta:
            'c6.\n\n```json\n{"text":"Bb5 pressures c6.","moves":["f1b5"],"arrows":[{"uci":"f1b5","brush":"green"}],"highlights":["c6"],"note":null}\n```',
        },
      };
      yield {
        type: 'session.text.ended',
        data: {
          sessionID: 'ses-v2',
          text: 'Bb5 pressures c6.\n\n```json\n{"text":"Bb5 pressures c6.","moves":["f1b5"],"arrows":[{"uci":"f1b5","brush":"green"}],"highlights":["c6"],"note":null}\n```',
        },
      };
      yield {
        type: 'session.usage.updated',
        data: {
          sessionID: 'ses-v2',
          cost: 0,
          tokens: { input: 500, output: 80, cache: { read: 100, write: 0 } },
        },
      };
      yield { type: 'session.execution.succeeded', data: { sessionID: 'ses-v2' } };
    }

    const v2Client: OpenCodeV2ClientLike = {
      async createSession(params) {
        createdDir = params.directory;
        expect(params.model).toEqual({ providerID: 'opencode', id: 'deepseek-v4.1-flash-free' });
        return { id: 'ses-v2', model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' } };
      },
      async subscribeEvents() {
        return makeV2Events();
      },
      async prompt() {},
      async interrupt() {},
      async deleteSession(id) {
        deletedSession = id;
      },
    };

    const coach = new OpenCodeCoach({
      createInstance: async () => ({
        apiVersion: 'v2',
        v2Client,
        server: { url: 'http://127.0.0.1:41234', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    const deltas: string[] = [];
    const reply = await coach.ask(
      { job: 'why', model: 'opencode/deepseek-v4.1-flash-free', brief: BRIEF },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).not.toContain('```');
    expect(deltas.join('').trim()).toBe('Bb5 pressures c6.');
    expect(reply.text).toBe('Bb5 pressures c6.');
    expect(reply.moves).toEqual(['f1b5']);
    expect(reply.arrows).toEqual([{ uci: 'f1b5', brush: 'green' }]);
    expect(reply.highlights).toEqual(['c6']);
    expect(reply.usage).toMatchObject({
      costUsd: 0,
      inputTokens: 500,
      outputTokens: 80,
      cacheReadTokens: 100,
      models: ['opencode/deepseek-v4.1-flash-free'],
    });
    expect(deletedSession).toBe('ses-v2');
    expect(createdDir).toBeDefined();
    expect(existsSync(createdDir!)).toBe(false);
  });

  it('rejects unexpected tool calls and maps v2 provider.free-limit errors with retryAfterMs', async () => {
    const interrupted: string[] = [];
    const rejectedPerms: string[] = [];

    const toolClient: OpenCodeV2ClientLike = {
      async createSession() {
        return { id: 'ses-tool' };
      },
      async subscribeEvents() {
        return (async function* () {
          yield {
            type: 'session.permission',
            data: { sessionID: 'ses-tool', requestID: 'req-1', action: 'bash' },
          };
        })();
      },
      async prompt() {},
      async interrupt(id) {
        interrupted.push(id);
      },
      async rejectPermission(_sid, reqId) {
        rejectedPerms.push(reqId);
      },
      async deleteSession() {},
    };

    const toolCoach = new OpenCodeCoach({
      createInstance: async () => ({
        apiVersion: 'v2',
        v2Client: toolClient,
        server: { url: 'http://127.0.0.1:41234', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(toolCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toThrow(
      /unexpected tool call \(bash\)/i,
    );
    expect(interrupted).toEqual(['ses-tool']);
    expect(rejectedPerms).toEqual(['req-1']);

    const limitClient: OpenCodeV2ClientLike = {
      ...toolClient,
      async createSession() {
        return { id: 'ses-limit' };
      },
      async subscribeEvents() {
        return (async function* () {
          yield {
            type: 'session.execution.failed',
            data: {
              sessionID: 'ses-limit',
              error: {
                type: 'provider.free-limit',
                status: 429,
                message: 'Free usage limit reached.',
                retryAfterMs: 60_000,
              },
            },
          };
        })();
      },
    };

    const limitCoach = new OpenCodeCoach({
      createInstance: async () => ({
        apiVersion: 'v2',
        v2Client: limitClient,
        server: { url: 'http://127.0.0.1:41234', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    const err = await limitCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoachLimitError);
    expect((err as CoachLimitError).resetsAt).toBeInstanceOf(Date);
  });

  it('rejects v2 streams that disconnect or error before session.execution.succeeded', async () => {
    const eofClient: OpenCodeV2ClientLike = {
      async createSession() {
        return { id: 'ses-eof' };
      },
      async subscribeEvents() {
        return (async function* () {
          yield { type: 'session.text.delta', data: { sessionID: 'ses-eof', delta: 'Partial explanation ' } };
        })();
      },
      async prompt() {},
      async interrupt() {},
      async deleteSession() {},
    };

    const eofCoach = new OpenCodeCoach({
      createInstance: async () => ({
        apiVersion: 'v2',
        v2Client: eofClient,
        server: { url: 'http://127.0.0.1:41234', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(eofCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toThrow(
      /disconnected before completing/i,
    );

    const dropClient: OpenCodeV2ClientLike = {
      ...eofClient,
      async createSession() {
        return { id: 'ses-drop' };
      },
      async subscribeEvents() {
        return (async function* () {
          yield { type: 'session.text.delta', data: { sessionID: 'ses-drop', delta: 'Partial explanation ' } };
          throw new Error('socket hang up');
        })();
      },
    };

    const dropCoach = new OpenCodeCoach({
      createInstance: async () => ({
        apiVersion: 'v2',
        v2Client: dropClient,
        server: { url: 'http://127.0.0.1:41234', close: () => {} },
      }),
      checkAuth: async () => ({ ok: true, path: '/usr/local/bin/opencode', authSource: 'opencode-cli' }),
    });

    await expect(dropCoach.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toThrow(
      /socket hang up/i,
    );
  });
});
