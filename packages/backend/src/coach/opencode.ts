// OpenCode Coach: talks to the local OpenCode CLI via `@opencode-ai/sdk/v2`, reusing the owner's
// local OpenCode provider logins (`opencode auth login`) or OpenCode's built-in free Zen models.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  createOpencode,
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

/** Built-in OpenCode tools disabled so the Coach remains strictly text-only. */
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

/** Minimal OpenCode client interface used by `OpenCodeCoach`, so tests can inject a deterministic double. */
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

export interface OpenCodeInstanceLike {
  client: OpenCodeClientLike;
  server: {
    url: string;
    close(): void;
  };
}

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

function formatOpenCodeError(err: unknown): { name?: string; statusCode?: number; message: string } {
  if (!err) return { message: 'OpenCode returned an unknown error.' };
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    const data = (obj.data && typeof obj.data === 'object' ? obj.data : undefined) as Record<string, unknown> | undefined;
    const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : undefined;
    const msg =
      (typeof data?.message === 'string' && data.message) ||
      (typeof obj.message === 'string' && obj.message) ||
      JSON.stringify(err);
    return { ...(name ? { name } : {}), ...(statusCode !== undefined ? { statusCode } : {}), message: msg };
  }
  return { message: String(err) };
}

function withPathDir<T>(cliPath: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!cliPath) return fn();
  const dir = dirname(cliPath);
  const current = process.env.PATH ?? '';
  const parts = current.split(delimiter);
  if (parts.includes(dir)) return fn();
  process.env.PATH = current ? `${dir}${delimiter}${current}` : dir;
  return fn();
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
      options.createInstance ??
      ((opts) =>
        withPathDir(this.opencodePath, () =>
          createOpencode(opts) as Promise<OpenCodeInstanceLike>,
        ));
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
    let sessionID: string | undefined;
    let client: OpenCodeClientLike | undefined;

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
      client = inst.client;

      const created = await client.session.create({
        directory: workingDirectory,
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
        if (sessionID && client) {
          void client.session.abort({ sessionID, directory: workingDirectory }).catch(() => {});
        }
      };
      controller.signal.addEventListener('abort', onRunAbort, { once: true });

      let rawStreamed = '';
      let emittedText = '';
      const partTextById = new Map<string, string>();
      let streamError: { name?: string; statusCode?: number; message: string } | undefined;
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
          const sub = await client.event.subscribe({ directory: workingDirectory }, { signal: streamAbort.signal });
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
                void client.session.abort({ sessionID, directory: workingDirectory }).catch(() => {});
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
            directory: workingDirectory,
            ...(modelSpec ? { model: modelSpec } : {}),
            tools: OPENCODE_DISABLED_TOOLS,
            format: {
              type: 'json_schema',
              schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
              retryCount: 2,
            },
            system: SYSTEM_PROMPT,
            parts: [{ type: 'text', text: userPrompt(call.brief) }],
          },
          { signal: controller.signal },
        );

        streamAbort.abort();
        await streamTask;

        if (timedOut && call.deadlineMs) throw new CoachDeadlineError(call.deadlineMs);
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
            : modelSpec
              ? `${modelSpec.providerID}/${modelSpec.modelID}`
              : 'opencode';

        const usage: CoachUsage | undefined = info.tokens
          ? {
              costUsd: typeof info.cost === 'number' ? info.cost : 0,
              inputTokens: info.tokens.input ?? 0,
              outputTokens: info.tokens.output ?? 0,
              cacheReadTokens: info.tokens.cache?.read ?? 0,
              cacheWriteTokens: info.tokens.cache?.write ?? 0,
              ms: Date.now() - started,
              turns: 1,
              models: [modelLabel],
            }
          : undefined;

        this.unavailableReason = undefined;
        return usage ? { ...rawReply, usage } : rawReply;
      } finally {
        controller.signal.removeEventListener('abort', onRunAbort);
        streamAbort.abort();
        await streamTask;
      }
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
      if (sessionID && client) {
        await client.session.delete({ sessionID, directory: workingDirectory }).catch(() => {});
      }
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }

  private mapError(err: { name?: string; statusCode?: number; message: string }): Error {
    const combined = err.name ? `${err.name}: ${err.message}` : err.message;
    if (err.name === 'ProviderAuthError' || err.statusCode === 401 || err.statusCode === 403 || isOpenCodeAuthError(combined)) {
      const reason = `OpenCode could not authenticate. ${OPENCODE_LOGIN_FIX}`;
      this.unavailableReason = reason;
      return new CoachUnavailableError(reason);
    }
    if (err.statusCode === 429 || isOpenCodeLimitError(combined)) {
      return new CoachLimitError(`OpenCode provider rate or usage limit reached. (${err.message})`);
    }
    return new Error(err.message);
  }
}
