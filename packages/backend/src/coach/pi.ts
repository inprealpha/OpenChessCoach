// Pi Coach: runs the Coach through `@earendil-works/pi-coding-agent`, reusing the owner's
// `~/.pi/agent` authentication and model registry while disabling built-in filesystem/shell tools.
import { tmpdir } from 'node:os';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { EngineQuestion } from '@chess-coach/shared/coach/engine-tool';
import type { CoachRawReply, CoachUsage } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { PI_LOGIN_FIX, checkPi, isPiAuthError, isPiLimitError, type PiCheckResult } from '../pi-check.ts';
import { parseTextAndStructuredReply } from './parse.ts';
import {
  CoachDeadlineError,
  CoachLimitError,
  CoachUnavailableError,
  type CoachCall,
  type CoachEngine,
  type CoachPort,
} from './port.ts';
import { engineToolPrompt, SYSTEM_PROMPT, userPrompt } from './prompts.ts';

/** How long a call with the Engine tool may take before it is aborted (matches `RealCoach`). */
const ENGINE_DEADLINE_MS = 90_000;

/** Minimal session interface used by `PiCoach`, so tests can inject a deterministic double. */
export interface PiSessionLike {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  getLastAssistantText(): string | undefined;
  getSessionStats?(): {
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    cost?: number;
    assistantMessages?: number;
  };
  modelId?: string;
  dispose(): void;
}

export interface PiSessionRequest {
  model: string;
  systemPrompt: string;
  customTools: ToolDefinition[];
}

export interface PiCoachOptions {
  /** Injected session factory for deterministic tests. */
  createSession?: (req: PiSessionRequest) => Promise<PiSessionLike>;
  /** Injected local credential check for deterministic tests. */
  checkAuth?: () => Promise<PiCheckResult>;
  /** Override the Engine-tool deadline in tests. */
  deadlineMs?: number;
}

const PI_STRUCTURED_SUFFIX = `

After your plain-language explanation, append a fenced JSON block with the structured data:
\`\`\`json
{"text":"<same plain-language explanation>","moves":[],"arrows":[],"highlights":[],"note":null}
\`\`\``;

const ASK_ENGINE_PARAMETERS = {
  type: 'object',
  properties: {
    line: {
      type: 'array',
      items: { type: 'string' },
      description: "SAN moves played one after another from the brief's fen. Leave out for the brief's position.",
    },
    move: {
      type: 'string',
      description: 'One SAN move in the position after the line, to grade and explain.',
    },
  },
  additionalProperties: false,
} as const;

function buildAskEngineTool(engine: CoachEngine): ToolDefinition {
  return {
    name: 'ask_engine',
    label: 'Ask chess engine',
    description: `Ask the Engine about the position after a line of moves from the brief's position, and optionally one move there. At most ${engine.maxQuestions} questions per answer.`,
    parameters: ASK_ENGINE_PARAMETERS as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const question: EngineQuestion = {
        ...(Array.isArray(args.line) ? { line: args.line.filter((m): m is string => typeof m === 'string') } : {}),
        ...(typeof args.move === 'string' ? { move: args.move } : {}),
      };
      const answer = await engine.ask(question);
      return {
        content: [{ type: 'text', text: answer.text }],
        details: { refused: answer.refused },
      };
    },
  };
}

export function resolvePiModel<T extends { provider: string; id: string }>(
  available: readonly T[],
  requested: string,
): T | undefined {
  const trimmed = requested.trim();
  if (!trimmed || trimmed === 'default') return undefined;
  const slash = trimmed.indexOf('/');
  const match =
    slash > 0
      ? available.find((m) => m.provider === trimmed.slice(0, slash) && m.id === trimmed.slice(slash + 1))
      : available.find((m) => m.id === trimmed) ?? available.find((m) => m.id.includes(trimmed));
  if (!match) {
    throw new Error(`Model "${trimmed}" is not available in Pi. Check your logged-in Pi providers and model IDs.`);
  }
  return match;
}

/**
 * Build isolated resource-loader options for Pi Coach sessions so personal coding-agent
 * extensions, skills, prompt templates, themes, and context files are never loaded.
 */
export function buildPiResourceLoaderOptions(systemPrompt: string): ConstructorParameters<typeof DefaultResourceLoader>[0] {
  return {
    cwd: tmpdir(),
    agentDir: getAgentDir(),
    noExtensions: true,
    disabledBuiltinExtensions: ['mcp'],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  };
}

/** Tool allowlist passed to Pi: only the registered custom tools (e.g. `ask_engine`), never built-ins. */
export function buildPiToolAllowlist(customTools: ToolDefinition[]): string[] {
  return customTools.map((t) => t.name);
}

async function defaultCreateSession(req: PiSessionRequest): Promise<PiSessionLike> {
  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  const model = resolvePiModel(available, req.model);
  const resourceLoader = new DefaultResourceLoader(buildPiResourceLoaderOptions(req.systemPrompt));
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: tmpdir(),
    modelRuntime,
    resourceLoader,
    ...(model ? { model } : {}),
    noTools: req.customTools.length > 0 ? 'builtin' : 'all',
    tools: buildPiToolAllowlist(req.customTools),
    customTools: req.customTools,
    sessionManager: SessionManager.inMemory(),
  });
  const modelId = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
  return {
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text),
    abort: () => session.abort(),
    getLastAssistantText: () => session.getLastAssistantText(),
    getSessionStats: () => session.getSessionStats(),
    ...(modelId ? { modelId } : {}),
    dispose() {
      session.dispose();
      void modelRuntime.settleCredentialWrites().catch(() => {});
    },
  };
}

export class PiCoach implements CoachPort {
  readonly name = 'pi' as const;
  readonly provider = 'pi' as const;
  readonly supportsEngineTool = true;

  private readonly createSession: (req: PiSessionRequest) => Promise<PiSessionLike>;
  private readonly checkAuth: () => Promise<PiCheckResult>;
  private readonly deadlineMs: number;
  private unavailableReason: string | undefined;

  constructor(options: PiCoachOptions = {}) {
    this.createSession = options.createSession ?? defaultCreateSession;
    this.checkAuth = options.checkAuth ?? (() => checkPi());
    this.deadlineMs = options.deadlineMs ?? ENGINE_DEADLINE_MS;
  }

  async status(): Promise<CoachStatus> {
    if (this.unavailableReason) {
      const check = await this.checkAuth();
      if (check.ok) {
        this.unavailableReason = undefined;
        return { state: 'ready', provider: 'pi' };
      }
      return { state: 'unavailable', provider: 'pi', reason: this.unavailableReason };
    }
    const check = await this.checkAuth();
    if (!check.ok) return { state: 'unavailable', provider: 'pi', reason: check.message };
    return { state: 'ready', provider: 'pi' };
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    const started = Date.now();
    const engine = call.engine;
    const systemPrompt =
      (engine ? SYSTEM_PROMPT + engineToolPrompt(engine.maxQuestions, call.brief.summary !== undefined, call.brief.job) : SYSTEM_PROMPT) +
      PI_STRUCTURED_SUFFIX;

    const customTools = engine ? [buildAskEngineTool(engine)] : [];
    const session = await this.createSession({
      model: call.model,
      systemPrompt,
      customTools,
    });

    let late = false;
    const deadlineMs = call.deadlineMs ?? this.deadlineMs;
    const onAbort = () => {
      void session.abort().catch(() => {});
    };
    call.signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = engine
      ? setTimeout(() => {
          late = true;
          void session.abort().catch(() => {});
        }, deadlineMs)
      : undefined;

    // Buffer text when the Engine tool is available so thinking-aloud before ask_engine never leaks,
    // and stop streaming as soon as the trailing ```json block begins.
    let currentTurnText = '';
    let streamedLen = 0;
    let sawToolThisTurn = false;
    let enteredFence = false;
    let streamError: string | undefined;

    const flushSafeProse = (force: boolean) => {
      if (enteredFence) return;
      const fenceIdx = currentTurnText.indexOf('```');
      if (fenceIdx >= 0) {
        const before = currentTurnText.slice(streamedLen, fenceIdx);
        if (before) onText(before);
        streamedLen = fenceIdx;
        enteredFence = true;
        return;
      }
      // Keep the last 2 chars buffered while streaming in case a ``` fence is split across deltas.
      const safeEnd = force ? currentTurnText.length : Math.max(streamedLen, currentTurnText.length - 2);
      if (safeEnd > streamedLen) {
        onText(currentTurnText.slice(streamedLen, safeEnd));
        streamedLen = safeEnd;
      }
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        sawToolThisTurn = true;
        currentTurnText = '';
        streamedLen = 0;
        enteredFence = false;
        return;
      }
      if (event.type === 'message_start') {
        const msg = event.message as { role?: string } | undefined;
        if (!msg?.role || msg.role === 'assistant') streamError = undefined;
        currentTurnText = '';
        streamedLen = 0;
        sawToolThisTurn = false;
        enteredFence = false;
        return;
      }
      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent;
        if (ae.type === 'text_delta' && ae.delta) {
          currentTurnText += ae.delta;
          if (!engine || engine.exhausted) flushSafeProse(false);
        } else if (ae.type === 'error') {
          streamError = ae.error.errorMessage || 'Pi returned an error.';
        }
        return;
      }
      if (event.type === 'message_end') {
        const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (msg?.role === 'assistant') {
          if (msg.stopReason === 'error') {
            streamError = msg.errorMessage || 'Pi returned an error.';
            return;
          }
          streamError = undefined;
        }
        if (!sawToolThisTurn && currentTurnText) flushSafeProse(true);
      }
    });

    try {
      await session.prompt(userPrompt(call.brief));

      if (late) throw new CoachDeadlineError(deadlineMs);
      if (streamError) this.throwMappedError(streamError);

      const finalText = session.getLastAssistantText() ?? currentTurnText;
      const parsed = parseTextAndStructuredReply(finalText);
      if (parsed.text && streamedLen === 0) onText(parsed.text);

      const stats = session.getSessionStats?.();
      const usage: CoachUsage | undefined = stats?.tokens
        ? {
            costUsd: stats.cost ?? 0,
            inputTokens: stats.tokens.input ?? 0,
            outputTokens: stats.tokens.output ?? 0,
            cacheReadTokens: stats.tokens.cacheRead ?? 0,
            cacheWriteTokens: stats.tokens.cacheWrite ?? 0,
            turns: stats.assistantMessages ?? 1,
            ms: Date.now() - started,
            models: call.model && call.model !== 'default' ? [call.model] : [session.modelId ?? 'pi'],
          }
        : undefined;

      this.unavailableReason = undefined;
      return { ...parsed, ...(usage ? { usage } : {}) };
    } catch (err) {
      if (late) throw new CoachDeadlineError(deadlineMs);
      if (err instanceof CoachDeadlineError || err instanceof CoachLimitError || err instanceof CoachUnavailableError) throw err;
      if (call.signal?.aborted) throw err;
      throw this.mapError(err instanceof Error ? err.message : String(err));
    } finally {
      if (deadline) clearTimeout(deadline);
      call.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      session.dispose();
    }
  }

  private throwMappedError(message: string): never {
    throw this.mapError(message);
  }

  private mapError(message: string): Error {
    if (isPiLimitError(message)) {
      return new CoachLimitError('Your Pi provider usage limit has been reached.');
    }
    if (isPiAuthError(message)) {
      const reason = `Pi is not logged in on the desktop. ${PI_LOGIN_FIX}`;
      this.unavailableReason = reason;
      return new CoachUnavailableError(reason);
    }
    return new Error(message || 'Pi did not return a reply.');
  }
}
