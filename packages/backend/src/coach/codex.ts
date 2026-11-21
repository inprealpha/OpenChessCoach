// Codex Coach: talks to the local Codex CLI via `@openai/codex-sdk`, preserving the owner's
// ChatGPT subscription login (`~/.codex/auth.json`) or `OPENAI_API_KEY` / `CODEX_API_KEY`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import type { CoachRawReply, CoachUsage } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import {
  CODEX_LOGIN_FIX,
  checkCodex,
  isCodexAuthError,
  isCodexLimitError,
  type CodexCheckResult,
} from '../codex-check.ts';
import { extractPartialJsonText, parseTextAndStructuredReply } from './parse.ts';
import { CoachLimitError, CoachUnavailableError, type CoachCall, type CoachPort } from './port.ts';
import { REPLY_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompts.ts';

/** Minimal thread interface used by `CodexCoach`, so tests can inject a deterministic double. */
export interface CodexThreadLike {
  runStreamed(input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

/** Minimal client interface used by `CodexCoach`. */
export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

/**
 * Codex CLI config overrides that keep the Coach strictly text-only: no shell execution,
 * no MCP servers, and no desktop/browser/app tools.
 */
export const CODEX_ISOLATED_CONFIG = {
  features: {
    shell_tool: false,
    unified_exec: false,
    apps: false,
    computer_use: false,
    browser_use: false,
  },
  mcp_servers: {},
} as const;

export interface CodexCoachOptions {
  /** Override the `codex` binary path when found outside PATH. */
  codexPath?: string;
  /** Injected Codex client factory for deterministic tests. */
  createClient?: (options?: CodexOptions) => CodexClientLike;
  /** Injected local credential check for deterministic tests. */
  checkAuth?: () => Promise<CodexCheckResult>;
}

function buildCodexPrompt(call: CoachCall): string {
  return `${SYSTEM_PROMPT}\n\nReturn a single JSON object matching the required output schema.\n\n${userPrompt(call.brief)}`;
}

export class CodexCoach implements CoachPort {
  readonly name = 'codex' as const;
  readonly provider = 'codex' as const;
  /** `@openai/codex-sdk` does not expose an in-process custom tool / SDK MCP server API. */
  readonly supportsEngineTool = false;

  private readonly codexPath: string | undefined;
  private readonly createClient: (options?: CodexOptions) => CodexClientLike;
  private readonly checkAuth: () => Promise<CodexCheckResult>;
  private client: CodexClientLike | undefined;
  private unavailableReason: string | undefined;

  constructor(options: CodexCoachOptions = {}) {
    this.codexPath = options.codexPath;
    this.createClient = options.createClient ?? ((opts) => new Codex(opts));
    this.checkAuth = options.checkAuth ?? (() => checkCodex());
  }

  private getClient(): CodexClientLike {
    if (!this.client) {
      this.client = this.createClient({
        ...(this.codexPath ? { codexPathOverride: this.codexPath } : {}),
        config: CODEX_ISOLATED_CONFIG,
      });
    }
    return this.client;
  }

  async status(): Promise<CoachStatus> {
    if (this.unavailableReason) {
      const check = await this.checkAuth();
      if (check.ok) {
        this.unavailableReason = undefined;
        return { state: 'ready', provider: 'codex' };
      }
      return { state: 'unavailable', provider: 'codex', reason: this.unavailableReason };
    }
    const check = await this.checkAuth();
    if (!check.ok) return { state: 'unavailable', provider: 'codex', reason: check.message };
    return { state: 'ready', provider: 'codex' };
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    const started = Date.now();
    const model = call.model.trim();
    const workingDirectory = mkdtempSync(join(tmpdir(), 'chess-coach-codex-'));
    const threadOptions: ThreadOptions = {
      ...(model && model !== 'default' ? { model } : {}),
      sandboxMode: 'read-only',
      workingDirectory,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
    };

    const thread = this.getClient().startThread(threadOptions);
    const turnOptions: TurnOptions = {
      outputSchema: REPLY_SCHEMA as unknown as Record<string, unknown>,
      ...(call.signal ? { signal: call.signal } : {}),
    };

    let streamedText = '';
    let finalRawText = '';
    let usage: CoachUsage | undefined;

    const emitNewText = (fullTextSoFar: string): void => {
      if (fullTextSoFar.length <= streamedText.length) return;
      const delta = fullTextSoFar.slice(streamedText.length);
      streamedText = fullTextSoFar;
      onText(delta);
    };

    try {
      const { events } = await thread.runStreamed(buildCodexPrompt(call), turnOptions);
      for await (const event of events) {
        if (
          (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') &&
          (event.item.type === 'command_execution' || event.item.type === 'file_change' || event.item.type === 'mcp_tool_call')
        ) {
          throw new Error('Codex attempted an unexpected local tool call during a Coach reply.');
        }
        if (event.type === 'item.updated' && event.item.type === 'agent_message') {
          const partial = extractPartialJsonText(event.item.text);
          if (partial) emitNewText(partial);
        } else if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          finalRawText = event.item.text;
        } else if (event.type === 'turn.completed') {
          usage = {
            costUsd: 0,
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cacheReadTokens: event.usage.cached_input_tokens ?? 0,
            cacheWriteTokens: event.usage.cache_write_input_tokens ?? 0,
            turns: 1,
            ms: Date.now() - started,
            models: model && model !== 'default' ? [model] : ['codex'],
          };
        } else if (event.type === 'turn.failed') {
          this.throwMappedError(event.error.message);
        } else if (event.type === 'error') {
          this.throwMappedError(event.message);
        }
      }
    } catch (err) {
      if (err instanceof CoachLimitError || err instanceof CoachUnavailableError) throw err;
      if (call.signal?.aborted) throw err;
      this.throwMappedError(err instanceof Error ? err.message : String(err));
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }

    const parsed = parseTextAndStructuredReply(finalRawText);
    if (parsed.text && parsed.text.length > streamedText.length) {
      if (parsed.text.startsWith(streamedText)) {
        emitNewText(parsed.text);
      } else if (!streamedText) {
        emitNewText(parsed.text);
      }
    }

    this.unavailableReason = undefined;
    return { ...parsed, ...(usage ? { usage } : {}) };
  }

  private throwMappedError(message: string): never {
    if (isCodexLimitError(message)) {
      throw new CoachLimitError('Your Codex usage limit has been reached.');
    }
    if (isCodexAuthError(message)) {
      const reason = `Codex is not logged in on the desktop. ${CODEX_LOGIN_FIX}`;
      this.unavailableReason = reason;
      throw new CoachUnavailableError(reason);
    }
    throw new Error(message || 'Codex did not return a reply.');
  }
}
