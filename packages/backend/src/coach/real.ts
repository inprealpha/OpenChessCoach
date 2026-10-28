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
import { CoachLimitError, CoachUnavailableError, type CoachCall, type CoachEngine, type CoachPort } from './port.ts';
import { engineToolPrompt, REPLY_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompts.ts';

/** Turns without the Engine: the answer, and a retry of its structured output. */
const BASE_TURNS = 3;
const ENGINE_SERVER = 'engine';
const ENGINE_TOOL = 'ask_engine';
/** The tool's full name, the only tool the Coach may call. */
export const ENGINE_TOOL_NAME = `mcp__${ENGINE_SERVER}__${ENGINE_TOOL}`;
/**
 * Ceilings on a call with the Engine tool (ADR 0010), far above any normal answer (under 4,000
 * output tokens and 25 seconds in the off/on comparison): one answer ran away to 130,000 output
 * tokens over ten minutes, repeating itself until the model's own limit, twice.
 */
export const THINK_DEEPER_OUTPUT_TOKENS = 8000;
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
    const deadline = engine
      ? setTimeout(() => {
          late = true;
          abort.abort();
        }, this.deadlineMs)
      : undefined;
    const stream = this.query({
      prompt: userPrompt(call.brief),
      options: {
        model: call.model,
        systemPrompt: engine ? SYSTEM_PROMPT + engineToolPrompt(engine.maxQuestions) : SYSTEM_PROMPT,
        // No built-in tools, and no MCP servers but the Engine's: the Engine tool is the only one allowed to run.
        tools: [],
        allowedTools: engine ? [ENGINE_TOOL_NAME] : [],
        mcpServers: engine ? { [ENGINE_SERVER]: engineServer(engine) } : {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        // One more turn for each question; a question past the cap is refused before this stops the call.
        maxTurns: BASE_TURNS + (engine ? engine.maxQuestions : 0),
        cwd: tmpdir(),
        env: {
          ...process.env,
          // mcpServers: {} doesn't stop the claude.ai account's connectors, which add ~88,000 tokens to a call.
          ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
          // With the Engine tool, a ceiling on each response, so an answer that runs away can't spend the owner's limits.
          ...(engine ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(THINK_DEEPER_OUTPUT_TOKENS) } : {}),
        },
        abortController: abort,
        outputFormat: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> },
        // npm's claude.cmd can't be launched directly, so the SDK's own build runs on the same login.
        ...(this.claudePath && !isWindowsShim(this.claudePath) ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      },
    });
    let text = '';
    let structured: unknown;
    let usage: CoachUsage | undefined;
    try {
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
          usage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
            turns: message.num_turns,
            ms: Date.now() - started,
          };
        }
      }
    } catch (err) {
      if (late) throw tooLate(this.deadlineMs);
      throw err;
    } finally {
      clearTimeout(deadline);
    }
    if (late) throw tooLate(this.deadlineMs);
    return { ...toRawReply(text, structured), ...(usage ? { usage } : {}) };
  }
}

/** What the Player reads when a call with the Engine tool reaches its deadline. */
function tooLate(ms: number): Error {
  return new Error(`thinking deeper took longer than ${Math.round(ms / 1000)} seconds, so it stopped. Ask again, or turn Think deeper off in Settings.`);
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
