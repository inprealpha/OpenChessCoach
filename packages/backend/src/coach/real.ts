// The real Coach: Claude through the Claude Agent SDK, on the owner's own Claude Code login
// (ADR 0001). It has no built-in tools, no file access, no MCP servers of its own or from the
// claude.ai account's connectors, and no settings from disk. Its only possible tool is the
// desktop's Engine, as an in-process MCP server, with Think deeper on (ADR 0010).
import { createSdkMcpServer, query, tool, type McpServerConfig, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CoachRawReply, CoachUsage } from '@chess-coach/shared/coach/types';
import { MAX_QUESTION_PLIES } from '@chess-coach/shared/coach/engine-tool';
import { z } from 'zod';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { tmpdir } from 'node:os';
import { checkClaude, isWindowsShim } from '../claude-check.ts';
import { CoachDeadlineError, CoachLimitError, CoachUnavailableError, type CoachCall, type CoachEngine, type CoachPort } from './port.ts';
import { engineToolPrompt, REPLY_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompts.ts';

/** Turns without the Engine: the answer, and a retry of its structured output. */
const BASE_TURNS = 3;
const ENGINE_SERVER = 'engine';
const ENGINE_TOOL = 'ask_engine';
/** The tool's full name, the only tool the Coach may call. */
export const ENGINE_TOOL_NAME = `mcp__${ENGINE_SERVER}__${ENGINE_TOOL}`;
/**
 * Ceilings far above any normal answer (under 4,000 output tokens and 25 seconds in the off/on
 * comparison, ADR 0010): one answer ran away to 130,000 output tokens over ten minutes, repeating
 * itself until the model's own limit, twice. The output ceiling holds for every Coach call; the
 * deadline for a call with the Engine tool, which also waits on the Engine.
 */
export const COACH_OUTPUT_TOKENS = 8000;
export const THINK_DEEPER_DEADLINE_MS = 90_000;

/** The desktop's Engine as an in-process MCP server with one tool. It reads no files and opens no connections. */
function engineServer(engine: CoachEngine): McpServerConfig {
  const ask = tool(
    ENGINE_TOOL,
    `Ask the Engine about the position after a line of moves from the brief's position, and optionally one move there. At most ${engine.maxQuestions} questions per answer.`,
    {
      line: z.array(z.string()).max(MAX_QUESTION_PLIES).optional().describe("SAN moves played one after another from the brief's fen. Leave out for the brief's position."),
      move: z.string().optional().describe('One SAN move in the position after the line, to grade and explain.'),
    },
    async (args) => {
      const { text, refused } = await engine.ask({ ...(args.line ? { line: args.line } : {}), ...(args.move ? { move: args.move } : {}) });
      return { content: [{ type: 'text', text }], ...(refused ? { isError: true } : {}) };
    },
    { alwaysLoad: true },
  );
  return createSdkMcpServer({ name: ENGINE_SERVER, version: '1.0.0', tools: [ask], alwaysLoad: true });
}

export interface RealCoachOptions {
  /** Path to the `claude` executable the owner logged in with. */
  claudePath?: string;
  /** How long a call with the Engine tool may take. */
  deadlineMs?: number;
  /** The Agent SDK's `query`; tests pass their own to see the options the Coach sends. */
  query?: typeof query;
}

export class RealCoach implements CoachPort {
  readonly name = 'real' as const;
  private readonly claudePath: string | undefined;
  private readonly deadlineMs: number;
  private readonly query: typeof query;

  constructor(options: RealCoachOptions = {}) {
    this.claudePath = options.claudePath;
    this.deadlineMs = options.deadlineMs ?? THINK_DEEPER_DEADLINE_MS;
    this.query = options.query ?? query;
  }

  async status(): Promise<CoachStatus> {
    const check = await checkClaude(this.claudePath);
    return check.ok ? { state: 'ready' } : { state: 'unavailable', reason: check.message };
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    const abort = new AbortController();
    call.signal?.addEventListener('abort', () => abort.abort());
    const engine = call.engine;
    const started = Date.now();
    let late = false;
    const deadlineMs = call.deadlineMs ?? this.deadlineMs;
    const deadline = engine
      ? setTimeout(() => {
          late = true;
          abort.abort();
        }, deadlineMs)
      : undefined;
    const stream = this.query({
      prompt: userPrompt(call.brief),
      options: {
        model: call.model,
        systemPrompt: engine ? SYSTEM_PROMPT + engineToolPrompt(engine.maxQuestions, call.brief.summary !== undefined) : SYSTEM_PROMPT,
        // No built-in tools, and no MCP servers but the Engine's: the Engine tool is the only one allowed to run.
        tools: [],
        allowedTools: engine ? [ENGINE_TOOL_NAME] : [],
        mcpServers: engine ? { [ENGINE_SERVER]: engineServer(engine) } : {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        // A turn for every call the tool takes, refused ones included; the tool refuses any past
        // them, telling the Coach to answer, before this stops the call.
        maxTurns: BASE_TURNS + (engine ? engine.maxCalls : 0),
        cwd: tmpdir(),
        env: {
          ...process.env,
          // mcpServers: {} doesn't stop the claude.ai account's connectors, which add ~88,000 tokens to a call.
          ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
          // A ceiling on each response, so an answer that runs away can't spend the owner's limits.
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(COACH_OUTPUT_TOKENS),
        },
        abortController: abort,
        outputFormat: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> },
        // npm's claude.cmd can't be launched directly, so the SDK's own build runs on the same login.
        ...(this.claudePath && !isWindowsShim(this.claudePath) ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      },
    });
    let text = '';
    // With the Engine tool, a turn's text is held until the turn shows what it is: text the Coach
    // writes before asking the Engine is thinking aloud, which the Player never sees and the reply
    // never keeps. Once the turn moves on to its answer, or no question is left to ask, it streams.
    let held = '';
    let live = !engine;
    const show = (delta: string) => {
      if (!delta) return;
      text += delta;
      onText(delta);
    };
    let structured: unknown;
    let usage: CoachUsage | undefined;
    try {
      for await (const message of stream) {
        const delta = textDelta(message);
        if (delta) {
          if (live) show(delta);
          else held += delta;
        }
        const opened = toolStarted(message);
        if (engine && opened) {
          // Asking the Engine: what came before is thinking aloud. Anything else is the answer.
          if (opened === ENGINE_TOOL_NAME) live = false;
          else {
            show(held);
            live = true;
          }
          held = '';
        }
        if (engine && message.type === 'assistant' && !message.parent_tool_use_id) {
          if (!asksEngine(message)) show(held);
          held = '';
          live = engine.exhausted;
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
          if (held) show(held);
          if (message.subtype !== 'success') throw new Error(`The Coach stopped early (${message.subtype}).`);
          if (message.is_error) throw new Error(message.result || 'The Coach returned an error.');
          structured = (message as { structured_output?: unknown }).structured_output;
          usage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
            turns: message.num_turns,
            ms: Date.now() - started,
            costUsd: message.total_cost_usd,
            models: Object.keys(message.modelUsage ?? {}),
          };
        }
      }
    } catch (err) {
      if (late) throw new CoachDeadlineError(deadlineMs);
      throw err;
    } finally {
      clearTimeout(deadline);
    }
    if (late) throw new CoachDeadlineError(deadlineMs);
    return { ...toRawReply(text, structured), ...(usage ? { usage } : {}) };
  }
}

/** Whether a turn of the Coach's ends by asking the Engine. */
function asksEngine(message: Extract<SDKMessage, { type: 'assistant' }>): boolean {
  return message.message.content.some((block) => block.type === 'tool_use' && block.name === ENGINE_TOOL_NAME);
}

/** The name of a tool the Coach's turn starts calling, as it streams. */
function toolStarted(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event' || message.parent_tool_use_id) return undefined;
  const event = message.event;
  return event.type === 'content_block_start' && event.content_block.type === 'tool_use' ? event.content_block.name : undefined;
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
