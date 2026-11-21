// OpenCode Coach: talks to the local OpenCode CLI, supporting both OpenCode v1 (`@opencode-ai/sdk/v2`
// routes) and OpenCode v2 (`/api/*` HTTP + SSE with server password), reusing local provider logins
// (`opencode auth login`) or OpenCode's built-in free Zen models.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOpencodeClient,
  type AssistantMessage,
  type Config,
  type Event,
  type OutputFormat,
  type Part,
  type PermissionRuleset,
  type ServerOptions,
} from '@opencode-ai/sdk/v2';
import type { CoachRawReply, CoachUsage } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import {
  OPENCODE_LOGIN_FIX,
  checkOpenCode,
  isOpenCodeAuthError,
  isOpenCodeLimitError,
  type OpenCodeCheckResult,
} from '../opencode-check.ts';
import { extractPartialJsonText, parseTextAndStructuredReply, toRawReply } from './parse.ts';
import { CoachDeadlineError, CoachLimitError, CoachUnavailableError, type CoachCall, type CoachPort } from './port.ts';
import { REPLY_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompts.ts';

/** Built-in OpenCode tools disabled on v1 sessions so the Coach remains strictly text-only. */
export const OPENCODE_DISABLED_TOOLS: Record<string, boolean> = {
  bash: false,
  read: false,
  edit: false,
  write: false,
  glob: false,
  grep: false,
  webfetch: false,
  websearch: false,
  task: false,
  todowrite: false,
  todoread: false,
  skill: false,
  question: false,
  list: false,
  lsp: false,
  patch: false,
};

/**
 * OpenCode config overrides that keep the Coach strictly text-only: no shell, file, web,
 * plugin, LSP, formatter, snapshot, or MCP access.
 */
export const OPENCODE_ISOLATED_CONFIG: Config = {
  permission: 'deny',
  tools: OPENCODE_DISABLED_TOOLS,
  mcp: {},
  plugin: [],
  share: 'disabled',
  autoupdate: false,
  snapshot: false,
  lsp: false,
  formatter: false,
};

const DENY_ALL_PERMISSIONS: PermissionRuleset = [{ permission: '*', pattern: '*', action: 'deny' }];

/**
 * Server-level config passed via `OPENCODE_CONFIG_CONTENT` when spawning `opencode serve`.
 * Intentionally omits global `permission: "deny"` because OpenCode v2 Zen free models reject
 * requests with global deny-all; tool execution is instead blocked per-session and on SSE events.
 */
const OPENCODE_SERVER_CONFIG: Record<string, unknown> = {
  mcp: {},
  share: 'disabled',
  autoupdate: false,
  snapshot: false,
  lsp: false,
  formatter: false,
};

const OPENCODE_V2_STRUCTURED_SUFFIX = `

Answer directly in plain language without calling any tools.
After your plain-language explanation, append a fenced JSON block with the structured data:
\`\`\`json
{"text":"<same plain-language explanation>","moves":[],"arrows":[],"highlights":[],"note":null}
\`\`\``;

/** Minimal OpenCode v1 client interface used by `OpenCodeCoach`, so tests can inject a deterministic double. */
export interface OpenCodeClientLike {
  session: {
    create(params: {
      directory?: string;
      title?: string;
      permission?: PermissionRuleset;
    }): Promise<{ data?: { id: string }; error?: unknown }>;
    prompt(
      params: {
        sessionID: string;
        directory?: string;
        model?: { providerID: string; modelID: string };
        tools?: Record<string, boolean>;
        format?: OutputFormat;
        system?: string;
        parts?: Array<{ type: 'text'; text: string }>;
      },
      options?: { signal?: AbortSignal },
    ): Promise<{ data?: { info: AssistantMessage; parts: Array<Part> }; error?: unknown }>;
    abort(params: { sessionID: string; directory?: string }): Promise<unknown>;
    delete(params: { sessionID: string; directory?: string }): Promise<unknown>;
  };
  event: {
    subscribe(
      params?: { directory?: string },
      options?: { signal?: AbortSignal },
    ): Promise<{ stream: AsyncGenerator<Event, unknown, unknown> | AsyncIterable<Event> }>;
  };
}

/** Minimal OpenCode v2 HTTP+SSE event emitted by `GET /api/event`. */
export interface OpenCodeV2Event {
  type: string;
  data?: Record<string, unknown>;
}

/** Minimal OpenCode v2 client interface (`/api/*`), so tests can inject a deterministic double. */
export interface OpenCodeV2ClientLike {
  createSession(params: {
    title: string;
    directory: string;
    model?: { providerID: string; id: string };
  }): Promise<{ id: string; model?: { providerID: string; id: string } }>;
  subscribeEvents(signal: AbortSignal): Promise<AsyncIterable<OpenCodeV2Event>>;
  prompt(sessionID: string, text: string, signal: AbortSignal): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  rejectPermission?(sessionID: string, requestID: string): Promise<void>;
  deleteSession(sessionID: string): Promise<void>;
}

export type OpenCodeInstanceLike =
  | {
      apiVersion?: 'v1';
      client: OpenCodeClientLike;
      server: {
        url: string;
        close(): void;
      };
    }
  | {
      apiVersion: 'v2';
      v2Client: OpenCodeV2ClientLike;
      server: {
        url: string;
        close(): void;
      };
    };

export interface OpenCodeCoachOptions {
  /** Override the `opencode` binary path when found outside PATH. */
  opencodePath?: string;
  /** Injected OpenCode instance factory for deterministic tests. */
  createInstance?: (options?: ServerOptions) => Promise<OpenCodeInstanceLike>;
  /** Injected local availability check for deterministic tests. */
  checkAuth?: () => Promise<OpenCodeCheckResult>;
}

/**
 * Parses a Settings model string for OpenCode:
 * - `''` or `'default'` -> omit model (uses OpenCode's configured default / free model)
 * - `'provider/model'` -> `{ providerID, modelID }`
 * - `'model'` -> `{ providerID: 'opencode', modelID }` (OpenCode's built-in Zen provider)
 */
export function parseOpenCodeModel(model: string): { providerID: string; modelID: string } | undefined {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'default') return undefined;
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return {
      providerID: trimmed.slice(0, slash),
      modelID: trimmed.slice(slash + 1),
    };
  }
  return { providerID: 'opencode', modelID: trimmed };
}

/** Parses `opencode serve` startup stdout for either v1 (`opencode server listening on ...`) or v2 (`server listening on ...` + `server password ...`). */
export function parseOpenCodeServerBanner(output: string): {
  apiVersion: 'v1' | 'v2';
  url: string;
  password?: string;
} | undefined {
  let url: string | undefined;
  let apiVersion: 'v1' | 'v2' | undefined;
  let password: string | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const v1 = line.match(/^opencode server listening on\s+(https?:\/\/\S+)/);
    if (v1) {
      apiVersion = 'v1';
      url = v1[1];
      continue;
    }
    const v2 = line.match(/^server listening on\s+(https?:\/\/\S+)/);
    if (v2) {
      apiVersion = 'v2';
      url = v2[1];
      continue;
    }
    const pw = line.match(/^server password\s+(\S+)/);
    if (pw) {
      password = pw[1];
    }
  }
  if (!url || !apiVersion) return undefined;
  if (apiVersion === 'v2' && !password) return undefined;
  return { apiVersion, url, ...(password ? { password } : {}) };
}

interface ParsedOpenCodeError {
  name?: string;
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
}

function formatOpenCodeError(err: unknown): ParsedOpenCodeError {
  if (!err) return { message: 'OpenCode returned an unknown error.' };
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const name =
      (typeof obj.name === 'string' && obj.name) ||
      (typeof obj.type === 'string' && obj.type) ||
      undefined;
    const data = (obj.data && typeof obj.data === 'object' ? obj.data : undefined) as Record<string, unknown> | undefined;
    const statusCode =
      typeof data?.statusCode === 'number'
        ? data.statusCode
        : typeof obj.status === 'number'
          ? obj.status
          : typeof obj.statusCode === 'number'
            ? obj.statusCode
            : undefined;
    const retryAfterMs =
      typeof obj.retryAfterMs === 'number'
        ? obj.retryAfterMs
        : typeof data?.retryAfterMs === 'number'
          ? data.retryAfterMs
          : undefined;
    const msg =
      (typeof data?.message === 'string' && data.message) ||
      (typeof obj.message === 'string' && obj.message) ||
      JSON.stringify(err);
    return {
      ...(name ? { name } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      message: msg,
    };
  }
  return { message: String(err) };
}

async function readJsonError(res: Response): Promise<ParsedOpenCodeError> {
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const formatted = formatOpenCodeError(parsed);
      return { ...formatted, statusCode: formatted.statusCode ?? res.status };
    } catch {
      return { statusCode: res.status, message: text };
    }
  }
  return { statusCode: res.status, message: `OpenCode server returned HTTP ${res.status}.` };
}

function createOpenCodeV2Client(baseUrl: string, password: string): OpenCodeV2ClientLike {
  const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const jsonHeaders = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };

  return {
    async createSession(params) {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          title: params.title,
          location: { directory: params.directory },
          permissions: [{ action: '*', resource: '*', effect: 'ask' }],
          ...(params.model ? { model: params.model } : {}),
        }),
      });
      if (!res.ok) throw await readJsonError(res);
      const body = (await res.json()) as { data?: { id?: string; model?: { providerID: string; id: string } } };
      if (!body.data?.id) throw new Error('OpenCode did not return a session ID.');
      return { id: body.data.id, ...(body.data.model ? { model: body.data.model } : {}) };
    },

    async subscribeEvents(signal) {
      const res = await fetch(`${baseUrl}/api/event`, {
        headers: { Authorization: authHeader, Accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) throw await readJsonError(res);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const onAbort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });

      async function* stream(): AsyncGenerator<OpenCodeV2Event, void, unknown> {
        let buffer = '';
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
              const dataText = frame
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
                .join('\n');
              if (!dataText) continue;
              try {
                const parsed = JSON.parse(dataText) as OpenCodeV2Event;
                if (parsed && typeof parsed.type === 'string') yield parsed;
              } catch {
                // Ignore non-JSON SSE comments/heartbeats.
              }
            }
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          void reader.cancel().catch(() => {});
        }
      }
      return stream();
    },

    async prompt(sessionID, text, signal) {
      const res = await fetch(`${baseUrl}/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) throw await readJsonError(res);
    },

    async interrupt(sessionID) {
      await fetch(`${baseUrl}/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
        method: 'POST',
        headers: jsonHeaders,
      }).catch(() => {});
    },

    async rejectPermission(sessionID, requestID) {
      await fetch(
        `${baseUrl}/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
        {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ reply: 'reject' }),
        },
      ).catch(() => {});
    },

    async deleteSession(sessionID) {
      await fetch(`${baseUrl}/api/session/${encodeURIComponent(sessionID)}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
      }).catch(() => {});
    },
  };
}

async function startOpenCodeServer(
  opencodePath: string | undefined,
  options: ServerOptions = {},
): Promise<OpenCodeInstanceLike> {
  const hostname = options.hostname ?? '127.0.0.1';
  const port = options.port ?? 0;
  const timeoutMs = options.timeout ?? 15_000;
  const bin = opencodePath || 'opencode';

  const proc = spawn(bin, ['serve', `--hostname=${hostname}`, `--port=${port}`], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_SERVER_CONFIG),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const close = () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Ignore shutdown errors.
    }
    proc.unref();
  };

  const banner = await new Promise<{ apiVersion: 'v1' | 'v2'; url: string; password?: string }>((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      close();
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    const check = () => {
      if (settled) return;
      const parsed = parseOpenCodeServerBanner(output);
      if (parsed) {
        settled = true;
        clearTimeout(timer);
        resolve(parsed);
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      check();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      check();
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = output.trim() ? `\nServer output: ${output.trim()}` : '';
      reject(new Error(`OpenCode server exited with code ${code ?? 'unknown'}.${detail}`));
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });

  if (banner.apiVersion === 'v2' && banner.password) {
    return {
      apiVersion: 'v2',
      v2Client: createOpenCodeV2Client(banner.url, banner.password),
      server: { url: banner.url, close },
    };
  }

  const client = createOpencodeClient({ baseUrl: banner.url }) as unknown as OpenCodeClientLike;
  return {
    apiVersion: 'v1',
    client,
    server: { url: banner.url, close },
  };
}

export class OpenCodeCoach implements CoachPort {
  readonly name = 'opencode' as const;
  readonly provider = 'opencode' as const;
  /** `@opencode-ai/sdk` does not expose an in-process custom tool callback API. */
  readonly supportsEngineTool = false;

  private readonly opencodePath: string | undefined;
  private readonly createInstance: (options?: ServerOptions) => Promise<OpenCodeInstanceLike>;
  private readonly checkAuth: () => Promise<OpenCodeCheckResult>;
  private instancePromise: Promise<OpenCodeInstanceLike> | undefined;
  private instance: OpenCodeInstanceLike | undefined;
  private unavailableReason: string | undefined;

  constructor(options: OpenCodeCoachOptions = {}) {
    this.opencodePath = options.opencodePath;
    this.createInstance =
      options.createInstance ?? ((opts) => startOpenCodeServer(this.opencodePath, opts));
    this.checkAuth = options.checkAuth ?? (() => checkOpenCode());
  }

  private async getInstance(): Promise<OpenCodeInstanceLike> {
    if (this.instance) return this.instance;
    if (!this.instancePromise) {
      this.instancePromise = this.createInstance({
        hostname: '127.0.0.1',
        port: 0,
        timeout: 15_000,
        config: OPENCODE_ISOLATED_CONFIG,
      })
        .then((inst) => {
          this.instance = inst;
          return inst;
        })
        .catch((err) => {
          this.instancePromise = undefined;
          throw err;
        });
    }
    return this.instancePromise;
  }

  /** Stops the background local OpenCode server if this Coach started one. */
  close(): void {
    const inst = this.instance;
    this.instance = undefined;
    this.instancePromise = undefined;
    try {
      inst?.server.close();
    } catch {
      // Ignore shutdown errors.
    }
  }

  async status(): Promise<CoachStatus> {
    if (this.unavailableReason) {
      return { state: 'unavailable', provider: 'opencode', reason: this.unavailableReason };
    }
    const check = await this.checkAuth();
    if (!check.ok) return { state: 'unavailable', provider: 'opencode', reason: check.message };
    return { state: 'ready', provider: 'opencode' };
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    const started = Date.now();
    const workingDirectory = mkdtempSync(join(tmpdir(), 'chess-coach-opencode-'));
    const modelSpec = parseOpenCodeModel(call.model);

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (call.signal) {
      if (call.signal.aborted) controller.abort();
      else call.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const deadlineTimer =
      call.deadlineMs && call.deadlineMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, call.deadlineMs)
        : undefined;

    try {
      const inst = await this.getInstance();
      if (inst.apiVersion === 'v2') {
        return await this.askV2(inst.v2Client, call, onText, {
          started,
          workingDirectory,
          modelSpec,
          signal: controller.signal,
          isTimedOut: () => timedOut,
        });
      }
      return await this.askV1(inst.client, call, onText, {
        started,
        workingDirectory,
        modelSpec,
        signal: controller.signal,
        isTimedOut: () => timedOut,
      });
    } catch (err) {
      if (
        err instanceof CoachUnavailableError ||
        err instanceof CoachLimitError ||
        err instanceof CoachDeadlineError
      ) {
        throw err;
      }
      if (timedOut && call.deadlineMs) throw new CoachDeadlineError(call.deadlineMs);
      if (call.signal?.aborted) throw err;
      throw this.mapError(formatOpenCodeError(err));
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (call.signal) call.signal.removeEventListener('abort', onExternalAbort);
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }

  private async askV2(
    client: OpenCodeV2ClientLike,
    call: CoachCall,
    onText: (delta: string) => void,
    ctx: {
      started: number;
      workingDirectory: string;
      modelSpec: { providerID: string; modelID: string } | undefined;
      signal: AbortSignal;
      isTimedOut: () => boolean;
    },
  ): Promise<CoachRawReply> {
    let sessionID: string | undefined;
    const streamAbort = new AbortController();
    const onRunAbort = () => {
      streamAbort.abort();
      if (sessionID) void client.interrupt(sessionID);
    };
    ctx.signal.addEventListener('abort', onRunAbort, { once: true });

    try {
      const created = await client.createSession({
        title: `OpenChessCoach ${call.job}`,
        directory: ctx.workingDirectory,
        ...(ctx.modelSpec ? { model: { providerID: ctx.modelSpec.providerID, id: ctx.modelSpec.modelID } } : {}),
      });
      sessionID = created.id;

      // Subscribe before prompting so no SSE deltas or failure events can be missed.
      const stream = await client.subscribeEvents(streamAbort.signal);

      let rawText = '';
      let finalEndedText = '';
      let streamedLen = 0;
      let enteredFence = false;
      let unexpectedTool: string | undefined;
      let executionError: ParsedOpenCodeError | undefined;
      let stepModel: { providerID: string; id: string } | undefined;
      let usageInfo:
        | { cost?: number; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } }
        | undefined;

      const flushSafeProse = (force: boolean) => {
        if (enteredFence) return;
        const fenceIdx = rawText.indexOf('```');
        if (fenceIdx >= 0) {
          const before = rawText.slice(streamedLen, fenceIdx);
          if (before) onText(before);
          streamedLen = fenceIdx;
          enteredFence = true;
          return;
        }
        const safeEnd = force ? rawText.length : Math.max(streamedLen, rawText.length - 2);
        if (safeEnd > streamedLen) {
          onText(rawText.slice(streamedLen, safeEnd));
          streamedLen = safeEnd;
        }
      };

      const donePromise = (async () => {
        try {
          for await (const ev of stream) {
            if (streamAbort.signal.aborted) break;
            const d = ev.data;
            if (!d || d.sessionID !== sessionID) continue;

            if (ev.type === 'session.text.delta') {
              const delta = typeof d.delta === 'string' ? d.delta : typeof d.text === 'string' ? d.text : '';
              if (delta) {
                rawText += delta;
                flushSafeProse(false);
              }
            } else if (ev.type === 'session.text.ended') {
              if (typeof d.text === 'string' && d.text.length > finalEndedText.length) {
                finalEndedText = d.text;
              }
            } else if (ev.type === 'session.step.started') {
              const m = d.model as { providerID?: unknown; id?: unknown } | undefined;
              if (m && typeof m.providerID === 'string' && typeof m.id === 'string') {
                stepModel = { providerID: m.providerID, id: m.id };
              }
            } else if (ev.type === 'session.usage.updated') {
              usageInfo = {
                ...(typeof d.cost === 'number' ? { cost: d.cost } : {}),
                ...(d.tokens && typeof d.tokens === 'object'
                  ? {
                      tokens: d.tokens as {
                        input?: number;
                        output?: number;
                        cache?: { read?: number; write?: number };
                      },
                    }
                  : {}),
              };
            } else if (ev.type === 'session.tool.called' || ev.type === 'session.permission') {
              const toolName =
                (typeof d.tool === 'string' && d.tool) ||
                (typeof d.action === 'string' && d.action) ||
                'tool';
              unexpectedTool = toolName;
              if (ev.type === 'session.permission' && typeof d.requestID === 'string') {
                void client.rejectPermission?.(sessionID, d.requestID);
              }
              void client.interrupt(sessionID);
              break;
            } else if (ev.type === 'session.execution.failed') {
              executionError = formatOpenCodeError(d.error ?? 'OpenCode execution failed.');
              break;
            } else if (ev.type === 'session.execution.succeeded' || ev.type === 'session.execution.interrupted') {
              break;
            }
          }
        } catch {
          // Expected when streamAbort fires after completion or abort.
        }
      })();

      const fullPrompt = `${SYSTEM_PROMPT}${OPENCODE_V2_STRUCTURED_SUFFIX}\n\n${userPrompt(call.brief)}`;
      await client.prompt(sessionID, fullPrompt, ctx.signal);
      await donePromise;
      streamAbort.abort();

      if (ctx.isTimedOut() && call.deadlineMs) throw new CoachDeadlineError(call.deadlineMs);
      if (unexpectedTool) {
        throw new Error(`OpenCode attempted an unexpected tool call (${unexpectedTool}) during Coach reply.`);
      }
      if (executionError) throw this.mapError(executionError);

      flushSafeProse(true);
      const parsed = parseTextAndStructuredReply(finalEndedText || rawText);
      if (streamedLen === 0 && parsed.text) onText(parsed.text);

      const resolvedModel = created.model ?? stepModel;
      const modelLabel = resolvedModel
        ? `${resolvedModel.providerID}/${resolvedModel.id}`
        : ctx.modelSpec
          ? `${ctx.modelSpec.providerID}/${ctx.modelSpec.modelID}`
          : 'opencode';

      const usage: CoachUsage | undefined = usageInfo?.tokens
        ? {
            costUsd: usageInfo.cost ?? 0,
            inputTokens: usageInfo.tokens.input ?? 0,
            outputTokens: usageInfo.tokens.output ?? 0,
            cacheReadTokens: usageInfo.tokens.cache?.read ?? 0,
            cacheWriteTokens: usageInfo.tokens.cache?.write ?? 0,
            ms: Date.now() - ctx.started,
            turns: 1,
            models: [modelLabel],
          }
        : undefined;

      this.unavailableReason = undefined;
      return usage ? { ...parsed, usage } : parsed;
    } finally {
      ctx.signal.removeEventListener('abort', onRunAbort);
      streamAbort.abort();
      if (sessionID) await client.deleteSession(sessionID).catch(() => {});
    }
  }

  private async askV1(
    client: OpenCodeClientLike,
    call: CoachCall,
    onText: (delta: string) => void,
    ctx: {
      started: number;
      workingDirectory: string;
      modelSpec: { providerID: string; modelID: string } | undefined;
      signal: AbortSignal;
      isTimedOut: () => boolean;
    },
  ): Promise<CoachRawReply> {
    let sessionID: string | undefined;
    try {
      const created = await client.session.create({
        directory: ctx.workingDirectory,
        title: `OpenChessCoach ${call.job}`,
        permission: DENY_ALL_PERMISSIONS,
      });
      if (created.error || !created.data?.id) {
        const err = formatOpenCodeError(created.error ?? 'Failed to create OpenCode session.');
        throw this.mapError(err);
      }
      sessionID = created.data.id;

      const streamAbort = new AbortController();
      const onRunAbort = () => {
        streamAbort.abort();
        if (sessionID) {
          void client.session.abort({ sessionID, directory: ctx.workingDirectory }).catch(() => {});
        }
      };
      ctx.signal.addEventListener('abort', onRunAbort, { once: true });

      let rawStreamed = '';
      let emittedText = '';
      const partTextById = new Map<string, string>();
      let streamError: ParsedOpenCodeError | undefined;
      let unexpectedTool: string | undefined;

      const emitFromRaw = (nextRaw: string) => {
        if (!nextRaw) return;
        const trimmed = nextRaw.trimStart();
        if (trimmed.startsWith('{')) {
          const partial = extractPartialJsonText(trimmed);
          if (partial.length > emittedText.length && partial.startsWith(emittedText)) {
            const delta = partial.slice(emittedText.length);
            emittedText = partial;
            onText(delta);
          }
          return;
        }
        if (nextRaw.length > emittedText.length && nextRaw.startsWith(emittedText)) {
          const delta = nextRaw.slice(emittedText.length);
          emittedText = nextRaw;
          onText(delta);
        }
      };

      const streamTask = (async () => {
        try {
          const sub = await client.event.subscribe({ directory: ctx.workingDirectory }, { signal: streamAbort.signal });
          for await (const event of sub.stream) {
            if (streamAbort.signal.aborted) break;
            if (event.type === 'message.part.delta') {
              if (event.properties.sessionID !== sessionID) continue;
              if (event.properties.field !== 'text') continue;
              const prev = partTextById.get(event.properties.partID) ?? '';
              partTextById.set(event.properties.partID, prev + event.properties.delta);
              rawStreamed += event.properties.delta;
              emitFromRaw(rawStreamed);
            } else if (event.type === 'message.part.updated') {
              const part = event.properties.part;
              if (part.sessionID !== sessionID) continue;
              if (part.type === 'tool') {
                unexpectedTool = part.tool;
                streamAbort.abort();
                void client.session.abort({ sessionID, directory: ctx.workingDirectory }).catch(() => {});
                break;
              }
              if (part.type === 'text' && !part.ignored) {
                const prev = partTextById.get(part.id) ?? '';
                if (part.text.startsWith(prev) && part.text.length > prev.length) {
                  const delta = part.text.slice(prev.length);
                  partTextById.set(part.id, part.text);
                  rawStreamed += delta;
                  emitFromRaw(rawStreamed);
                }
              }
            } else if (event.type === 'session.error') {
              if (event.properties.sessionID && event.properties.sessionID !== sessionID) continue;
              streamError = formatOpenCodeError(event.properties.error);
            }
          }
        } catch {
          // Expected when streamAbort fires after prompt finishes.
        }
      })();

      try {
        const promptResult = await client.session.prompt(
          {
            sessionID,
            directory: ctx.workingDirectory,
            ...(ctx.modelSpec ? { model: ctx.modelSpec } : {}),
            tools: OPENCODE_DISABLED_TOOLS,
            format: {
              type: 'json_schema',
              schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
              retryCount: 2,
            },
            system: SYSTEM_PROMPT,
            parts: [{ type: 'text', text: userPrompt(call.brief) }],
          },
          { signal: ctx.signal },
        );

        streamAbort.abort();
        await streamTask;

        if (ctx.isTimedOut() && call.deadlineMs) throw new CoachDeadlineError(call.deadlineMs);
        if (unexpectedTool) {
          throw new Error(`OpenCode attempted an unexpected tool call (${unexpectedTool}) during Coach reply.`);
        }
        if (promptResult.error) {
          throw this.mapError(formatOpenCodeError(promptResult.error));
        }

        const data = promptResult.data;
        if (!data) {
          if (streamError) throw this.mapError(streamError);
          throw new Error('OpenCode returned an empty response.');
        }

        const { info, parts } = data;
        if (info.error) {
          throw this.mapError(formatOpenCodeError(info.error));
        }
        const toolPart = parts.find((p) => p.type === 'tool');
        if (toolPart && toolPart.type === 'tool') {
          throw new Error(`OpenCode attempted an unexpected tool call (${toolPart.tool}) during Coach reply.`);
        }

        const textFromParts = parts
          .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text' && !p.ignored)
          .map((p) => p.text)
          .join('');

        const rawReply: CoachRawReply =
          info.structured && typeof info.structured === 'object'
            ? toRawReply(info.structured, textFromParts || emittedText)
            : parseTextAndStructuredReply(textFromParts || rawStreamed);

        if (!emittedText && rawReply.text) {
          onText(rawReply.text);
        }

        const modelLabel =
          info.providerID && info.modelID
            ? `${info.providerID}/${info.modelID}`
            : ctx.modelSpec
              ? `${ctx.modelSpec.providerID}/${ctx.modelSpec.modelID}`
              : 'opencode';

        const usage: CoachUsage | undefined = info.tokens
          ? {
              costUsd: typeof info.cost === 'number' ? info.cost : 0,
              inputTokens: info.tokens.input ?? 0,
              outputTokens: info.tokens.output ?? 0,
              cacheReadTokens: info.tokens.cache?.read ?? 0,
              cacheWriteTokens: info.tokens.cache?.write ?? 0,
              ms: Date.now() - ctx.started,
              turns: 1,
              models: [modelLabel],
            }
          : undefined;

        this.unavailableReason = undefined;
        return usage ? { ...rawReply, usage } : rawReply;
      } finally {
        ctx.signal.removeEventListener('abort', onRunAbort);
        streamAbort.abort();
        await streamTask;
      }
    } finally {
      if (sessionID) {
        await client.session.delete({ sessionID, directory: ctx.workingDirectory }).catch(() => {});
      }
    }
  }

  private mapError(err: ParsedOpenCodeError): Error {
    const combined = err.name ? `${err.name}: ${err.message}` : err.message;
    if (
      err.name === 'ProviderAuthError' ||
      err.name === 'provider.auth' ||
      err.statusCode === 401 ||
      err.statusCode === 403 ||
      isOpenCodeAuthError(combined)
    ) {
      const reason = `OpenCode could not authenticate. ${OPENCODE_LOGIN_FIX}`;
      this.unavailableReason = reason;
      return new CoachUnavailableError(reason);
    }
    if (err.statusCode === 429 || err.name === 'provider.free-limit' || isOpenCodeLimitError(combined)) {
      const resetsAt = err.retryAfterMs && err.retryAfterMs > 0 ? new Date(Date.now() + err.retryAfterMs) : undefined;
      return new CoachLimitError(`OpenCode provider rate or usage limit reached. (${err.message})`, resetsAt);
    }
    return new Error(err.message);
  }
}
