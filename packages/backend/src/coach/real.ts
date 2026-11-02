// The real Coach: Claude through the Claude Agent SDK, on the owner's own Claude Code login
// (ADR 0001). It has no built-in tools, no file access, no MCP servers of its own or from the
// claude.ai account's connectors, and no settings from disk. Its only possible tool is the
// desktop's Engine, as an in-process MCP server, with Think deeper on (ADR 0010).
import { createSdkMcpServer, query, tool, type McpServerConfig, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CoachRawReply, CoachUsage } from '@chess-coach/shared/coach/types';
import { MAX_QUESTION_PLIES } from '@chess-coach/shared/coach/engine-tool';
import { z } from 'zod';
import type { CoachStatus } from '@chess-coach/shared/protocol';
import { tmpdir } from 'node:os';
import { checkClaude, isWindowsShim, refusedLogin } from '../claude-check.ts';
import { CoachDeadlineError, CoachLimitError, CoachUnavailableError, type CoachBack, type CoachCall, type CoachEngine, type CoachPort } from './port.ts';
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

/** What a short call to Claude says about the desktop's login (see {@link RealCoach.checkLogin}). */
export type LoginCheck =
  /** Claude answered: the Coach can answer too. */
  | { state: 'ok' }
  /** Claude turned the login down; `message` says how the owner fixes it. */
  | { state: 'refused'; message: string }
  /** The login works, but the owner's Claude usage limit is reached. */
  | { state: 'limit'; resetsAt?: Date }
  /** No answer either way: the desktop is offline, Claude is down or too slow. */
  | { state: 'unknown'; message: string };

/** How long the login check waits for Claude's answer: a real answer takes 2 to 3 seconds. */
export const LOGIN_CHECK_MS = 15_000;
/**
 * While Claude turns the login down, the Coach checks again after this long, then twice as long
 * each time up to {@link LOGIN_RECHECK_MAX_MS}, so it comes back once the owner logs in without
 * starting Claude Code every half minute all day. A device asking for the status checks sooner.
 */
export const LOGIN_RECHECK_MS = 30_000;
export const LOGIN_RECHECK_MAX_MS = 5 * 60_000;
/** Said after a turned-down login while the app runs: the owner doesn't need to restart it. */
export const COMES_BACK = 'The Coach comes back on its own once Claude takes the login again.';
const CHECK_PROMPT = 'Reply with OK.';

export interface RealCoachOptions {
  /** Path to the `claude` executable the owner logged in with. */
  claudePath?: string;
  /** How long a call with the Engine tool may take. */
  deadlineMs?: number;
  /** The Agent SDK's `query`; tests pass their own to see the options the Coach sends. */
  query?: typeof query;
  /** How long the login check waits for Claude. */
  loginCheckMs?: number;
  /** How often the login is checked again while Claude turns it down. */
  loginRecheckMs?: number;
}

export class RealCoach implements CoachPort {
  readonly name = 'real' as const;
  private readonly claudePath: string | undefined;
  private readonly deadlineMs: number;
  private readonly query: typeof query;
  private readonly loginCheckMs: number;
  private readonly loginRecheckMs: number;
  /** Set while Claude turns the desktop's login down: why, and when that was last checked. */
  private refused: { message: string; at: number } | undefined;
  /** Counts the times Claude turned the login down, so a check knows whether one came while it ran. */
  private refusals = 0;
  private checking: Promise<LoginCheck> | undefined;
  private recheck: NodeJS.Timeout | undefined;
  private listener: ((back: CoachBack) => void) | undefined;
  /** What a check found before anything watched, such as the usage limit at start-up: told on `watch`. */
  private untold: CoachBack | undefined;

  constructor(options: RealCoachOptions = {}) {
    this.claudePath = options.claudePath;
    this.deadlineMs = options.deadlineMs ?? THINK_DEEPER_DEADLINE_MS;
    this.query = options.query ?? query;
    this.loginCheckMs = options.loginCheckMs ?? LOGIN_CHECK_MS;
    this.loginRecheckMs = options.loginRecheckMs ?? LOGIN_RECHECK_MS;
  }

  async status(): Promise<CoachStatus> {
    const check = await checkClaude(this.claudePath);
    if (!check.ok) return { state: 'unavailable', reason: check.message };
    // `claude auth status` still says "logged in" for a login Claude turned down. When the last
    // answer is old enough, ask Claude again without waiting for it (it can take the check's whole
    // timeout offline): a reload after logging in hears the Coach is back as soon as Claude answers.
    if (this.refused && Date.now() - this.refused.at >= this.loginRecheckMs) void this.checkLogin();
    if (this.refused) return { state: 'unavailable', reason: `${this.refused.message} ${COMES_BACK}` };
    return { state: 'ready' };
  }

  watch(listener: (back: CoachBack) => void): void {
    this.listener = listener;
    if (this.untold) this.tell(this.untold);
  }

  /**
   * Whether Claude takes the desktop's login, from one short call on the smallest model, set up
   * like every Coach call. `claude auth status` only reads the login saved on the desktop, so it
   * can't tell a login that has expired or was signed out elsewhere; this can.
   */
  checkLogin(): Promise<LoginCheck> {
    const before = this.refusals;
    this.checking ??= this.askClaude().then((check) => {
      if (check.state === 'refused') this.refuse(check.message);
      // A Coach call Claude turned down while this check ran is newer news than its answer.
      else if (check.state !== 'unknown' && this.refusals === before) this.accept(check);
      else if (this.refused) this.refused.at = Date.now();
      return check;
    }).finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async askClaude(): Promise<LoginCheck> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.loginCheckMs);
    try {
      const stream = this.query({
        prompt: CHECK_PROMPT,
        options: { ...this.callOptions(abort), model: 'haiku', systemPrompt: CHECK_PROMPT, maxTurns: 1 },
      });
      for await (const message of stream) {
        const stop = callStopped(message);
        if (stop) return stop;
        if (message.type === 'assistant' && message.error) return { state: 'unknown', message: `Claude answered with an error (${message.error}).` };
        if (message.type === 'result') {
          return message.subtype === 'success' && !message.is_error ? { state: 'ok' } : { state: 'unknown', message: `Claude stopped early (${message.subtype}).` };
        }
      }
      return { state: 'unknown', message: 'Claude didn’t answer.' };
    } catch (err) {
      if (abort.signal.aborted) return { state: 'unknown', message: `Claude didn’t answer within ${Math.round(this.loginCheckMs / 1000)} seconds.` };
      return { state: 'unknown', message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      // Ends the Claude Code process when the answer came before the call finished.
      abort.abort();
    }
  }

  /** Claude turned the login down: the Coach says so until a check finds it works again. */
  private refuse(message: string): void {
    this.refused = { message, at: Date.now() };
    this.refusals++;
    if (!this.recheck) this.scheduleRecheck(this.loginRecheckMs);
  }

  private scheduleRecheck(delayMs: number): void {
    this.recheck = setTimeout(() => {
      void this.checkLogin().then(() => {
        if (this.refused) this.scheduleRecheck(Math.min(delayMs * 2, Math.max(LOGIN_RECHECK_MAX_MS, this.loginRecheckMs)));
      });
    }, delayMs).unref();
  }

  /** Claude takes the login: the Coach is back, or out of its usage limit, which the service keeps. */
  private accept(check: Extract<LoginCheck, { state: 'ok' | 'limit' }>): void {
    const was = this.refused;
    this.refused = undefined;
    clearTimeout(this.recheck);
    this.recheck = undefined;
    if (check.state === 'limit') this.tell({ limited: check.resetsAt ? { resetsAt: check.resetsAt } : {} });
    else if (was) this.tell({});
  }

  private tell(back: CoachBack): void {
    this.untold = this.listener ? undefined : back;
    this.listener?.(back);
  }

  /** What every call to Claude shares: no tools, no settings from disk, the owner's login. */
  private callOptions(abort: AbortController): Options {
    return {
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      cwd: tmpdir(),
      env: {
        ...process.env,
        // mcpServers: {} doesn't stop the claude.ai account's connectors, which add ~88,000 tokens to a call.
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        // A ceiling on each response, so an answer that runs away can't spend the owner's limits.
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(COACH_OUTPUT_TOKENS),
      },
      abortController: abort,
      // npm's claude.cmd can't be launched directly, so the SDK's own build runs on the same login.
      ...(this.claudePath && !isWindowsShim(this.claudePath) ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
    };
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
        ...this.callOptions(abort),
        model: call.model,
        systemPrompt: engine ? SYSTEM_PROMPT + engineToolPrompt(engine.maxQuestions, call.brief.summary !== undefined, call.brief.job) : SYSTEM_PROMPT,
        // No built-in tools, and no MCP servers but the Engine's: the Engine tool is the only one allowed to run.
        allowedTools: engine ? [ENGINE_TOOL_NAME] : [],
        mcpServers: engine ? { [ENGINE_SERVER]: engineServer(engine) } : {},
        includePartialMessages: true,
        // A turn for every call the tool takes, refused ones included; the tool refuses any past
        // them, telling the Coach to answer, before this stops the call.
        maxTurns: BASE_TURNS + (engine ? engine.maxCalls : 0),
        outputFormat: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> },
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
        const stop = callStopped(message);
        if (stop?.state === 'limit') throw new CoachLimitError('Your Claude usage limit has been reached.', stop.resetsAt);
        if (stop?.state === 'refused') {
          // Remembered, so the Coach stays unavailable rather than looking ready to the next Player.
          this.refuse(stop.message);
          throw new CoachUnavailableError(`${stop.message} ${COMES_BACK}`);
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

/** Whether a message from Claude ends the call: the usage limit is reached, or Claude turned the login down. */
function callStopped(message: SDKMessage): Extract<LoginCheck, { state: 'limit' | 'refused' }> | undefined {
  if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
    const resets = message.rate_limit_info.resetsAt;
    return { state: 'limit', ...(resets ? { resetsAt: new Date(resets * 1000) } : {}) };
  }
  if (message.type !== 'assistant' || !message.error) return undefined;
  if (message.error === 'rate_limit') return { state: 'limit' };
  const refused = refusedLogin(message.error);
  return refused ? { state: 'refused', message: refused } : undefined;
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
