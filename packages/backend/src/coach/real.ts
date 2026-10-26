// The real Coach: Claude through the Claude Agent SDK, on the owner's own Claude Code login
// (ADR 0001). It has no tools, no file access, no MCP servers and no settings from disk.
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { tmpdir } from 'node:os';
import { checkClaude, isWindowsShim } from '../claude-check.ts';
import { CoachLimitError, CoachUnavailableError, type CoachCall, type CoachPort } from './port.ts';
import { REPLY_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompts.ts';

export interface RealCoachOptions {
  /** Path to the `claude` executable the owner logged in with. */
  claudePath?: string;
}

export class RealCoach implements CoachPort {
  readonly name = 'real' as const;
  private readonly claudePath: string | undefined;

  constructor(options: RealCoachOptions = {}) {
    this.claudePath = options.claudePath;
  }

  async status(): Promise<CoachStatus> {
    const check = await checkClaude(this.claudePath);
    return check.ok ? { state: 'ready' } : { state: 'unavailable', reason: check.message };
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    const abort = new AbortController();
    call.signal?.addEventListener('abort', () => abort.abort());
    const stream = query({
      prompt: userPrompt(call.brief),
      options: {
        model: call.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        maxTurns: 3,
        cwd: tmpdir(),
        abortController: abort,
        outputFormat: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> },
        // npm's claude.cmd can't be launched directly, so the SDK's own build runs on the same login.
        ...(this.claudePath && !isWindowsShim(this.claudePath) ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      },
    });
    let text = '';
    let structured: unknown;
    for await (const message of stream) {
      const delta = textDelta(message);
      if (delta) {
        text += delta;
        onText(delta);
      }
      if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
        const resets = message.rate_limit_info.resetsAt;
        throw new CoachLimitError('Your Claude usage limit has been reached.', resets ? new Date(resets * 1000) : undefined);
      }
      if (message.type === 'assistant' && message.error) {
        if (message.error === 'rate_limit') throw new CoachLimitError('Your Claude usage limit has been reached.');
        if (message.error === 'authentication_failed') {
          throw new CoachUnavailableError('Claude Code is not logged in on the desktop. Run `claude` there and log in.');
        }
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error(`The Coach stopped early (${message.subtype}).`);
        if (message.is_error) throw new Error(message.result || 'The Coach returned an error.');
        structured = (message as { structured_output?: unknown }).structured_output;
      }
    }
    return toRawReply(text, structured);
  }
}

function textDelta(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event' || message.parent_tool_use_id) return undefined;
  const event = message.event;
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') return event.delta.text;
  return undefined;
}

/**
 * Turns the SDK's result into a reply. The explanation comes from the structured output, because
 * with a JSON schema the model often streams no plain text at all; streamed text is the fallback.
 */
export function toRawReply(streamed: string, structured: unknown): CoachRawReply {
  const data = (typeof structured === 'object' && structured !== null ? structured : {}) as Partial<CoachRawReply>;
  const text = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : streamed.trim();
  return {
    text,
    moves: Array.isArray(data.moves) ? data.moves.filter((m) => typeof m === 'string') : [],
    arrows: Array.isArray(data.arrows) ? data.arrows.filter((a) => typeof a?.uci === 'string') : [],
    highlights: Array.isArray(data.highlights) ? data.highlights.filter((h) => typeof h === 'string') : [],
    note: typeof data.note === 'string' ? data.note : null,
  };
}
