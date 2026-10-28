// What the real Coach hands the Claude Agent SDK, checked with a stand-in for the SDK's query:
// no tools but the Engine's, and only with Think deeper on, with ceilings on its time and output
// (ADR 0001, ADR 0010). No real model is called.
import { describe, expect, it } from 'vitest';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import type { Brief } from '@chess-coach/shared/coach/brief';
import { ENGINE_TOOL_NAME, RealCoach, THINK_DEEPER_OUTPUT_TOKENS } from '../src/coach/real.ts';
import type { CoachEngine } from '../src/coach/port.ts';

const brief: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  recentMoves: '',
  candidates: [],
  maxWords: 150,
  allowNote: false,
  hideMoves: false,
};
const engine: CoachEngine = { maxQuestions: 3, ask: async () => ({ text: '{}', refused: false }) };
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  total_cost_usd: 0.0123,
  modelUsage: { 'claude-haiku-5-5': {} },
  structured_output: { text: 'Develop a knight.', moves: [], arrows: [], highlights: [], note: null },
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
};

/** A stand-in for the SDK's query: records the options, then answers after `delayMs`, or never until aborted. */
function fakeQuery(seen: Options[], delayMs: number | 'never' = 0): typeof query {
  return ((params: { options?: Options }) => {
    const options = params.options ?? {};
    seen.push(options);
    return (async function* () {
      await new Promise<void>((resolve, reject) => {
        options.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')));
        if (delayMs !== 'never') setTimeout(resolve, delayMs);
      });
      yield result;
    })();
  }) as unknown as typeof query;
}

describe('the real Coach', () => {
  it('has no tools at all with Think deeper off', async () => {
    const seen: Options[] = [];
    const reply = await new RealCoach({ query: fakeQuery(seen) }).ask({ job: 'why', model: 'haiku', brief }, () => {});
    expect(reply.text).toBe('Develop a knight.');
    expect(reply.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, turns: 2, costUsd: 0.0123, models: ['claude-haiku-5-5'] });
    expect(seen[0]).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], maxTurns: 3 });
    // The claude.ai account's connectors stay out, and no ceiling is needed on a call without the tool.
    expect(seen[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(seen[0]?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(seen[0]?.systemPrompt).not.toContain('ask_engine');
  });

  it('has only the Engine tool with Think deeper on, a turn per question, and a ceiling on each response', async () => {
    const seen: Options[] = [];
    await new RealCoach({ query: fakeQuery(seen) }).ask({ job: 'why', model: 'haiku', brief, engine }, () => {});
    const options = seen[0];
    expect(options).toMatchObject({ tools: [], allowedTools: [ENGINE_TOOL_NAME], strictMcpConfig: true, settingSources: [], maxTurns: 6 });
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(['engine']);
    expect(options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(THINK_DEEPER_OUTPUT_TOKENS));
    // The Engine's server is the only one: the claude.ai account's connectors stay out here too.
    expect(options?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    // The rest of the environment still reaches Claude Code, so it finds the owner's login.
    expect(options?.env?.PATH).toBe(process.env.PATH);
    expect(options?.systemPrompt).toContain('ask_engine');
  });

  it('stops a call with the Engine tool at its deadline and says why', async () => {
    const coach = new RealCoach({ query: fakeQuery([], 'never'), deadlineMs: 20 });
    await expect(coach.ask({ job: 'why', model: 'haiku', brief, engine }, () => {})).rejects.toThrow(
      'thinking deeper took longer than 0 seconds, so it stopped. Ask again, or turn Think deeper off in Settings.',
    );
  });

  it('puts no deadline on a call without the Engine tool', async () => {
    const reply = await new RealCoach({ query: fakeQuery([], 60), deadlineMs: 10 }).ask({ job: 'why', model: 'haiku', brief }, () => {});
    expect(reply.text).toBe('Develop a knight.');
  });
});
