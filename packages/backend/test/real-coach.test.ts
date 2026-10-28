// What the real Coach hands the Claude Agent SDK, checked with a stand-in for the SDK's query:
// no tools but the Engine's, and only with Think deeper on, with ceilings on its time and output
// (ADR 0001, ADR 0010). No real model is called.
import { describe, expect, it } from 'vitest';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import type { Brief } from '@chess-coach/shared/coach/brief';
import { ENGINE_TOOL_NAME, RealCoach, COACH_OUTPUT_TOKENS } from '../src/coach/real.ts';
import { EngineTool } from '../src/coach/engine-tool.ts';
import type { EngineService } from '../src/engine/service.ts';
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
const engine: CoachEngine = { maxQuestions: 3, maxCalls: 5, exhausted: false, ask: async () => ({ text: '{}', refused: false }) };
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
    // The claude.ai account's connectors stay out, and every call has the ceiling on each response:
    // a runaway answer isn't special to the Engine tool.
    expect(seen[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(seen[0]?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(COACH_OUTPUT_TOKENS));
    expect(seen[0]?.systemPrompt).not.toContain('ask_engine');
  });

  it('has only the Engine tool with Think deeper on, a turn per question, and a ceiling on each response', async () => {
    const seen: Options[] = [];
    await new RealCoach({ query: fakeQuery(seen) }).ask({ job: 'why', model: 'haiku', brief, engine }, () => {});
    const options = seen[0];
    // A turn for every call the tool takes, refused ones included, besides the answer's own.
    expect(options).toMatchObject({ tools: [], allowedTools: [ENGINE_TOOL_NAME], strictMcpConfig: true, settingSources: [], maxTurns: 3 + engine.maxCalls });
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(['engine']);
    expect(options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(COACH_OUTPUT_TOKENS));
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

  it('still answers when some of its questions were refused', async () => {
    const stub = { analyse: async (fen: string) => ({ fen, depth: 10, lines: [] }), gradeAsked: async () => ({ move: { uci: 'e2e4', san: 'e4', score: { cp: 0 }, pv: ['e2e4'] }, replies: [] }) };
    const tool = new EngineTool(stub as unknown as EngineService, brief.fen);
    // A model that asks two questions with illegal moves, then three good ones, one turn each, then answers in two turns.
    const model = ((params: { options?: Options }) => {
      const maxTurns = params.options?.maxTurns ?? 0;
      return (async function* () {
        let turns = 0;
        for (const q of [{ move: 'Ke2' }, { line: ['Nf6'] }, {}, { move: 'e4' }, { line: ['d4'] }]) {
          turns++;
          await tool.ask(q);
        }
        turns += 2;
        yield turns > maxTurns ? { ...result, subtype: 'error_max_turns' } : result;
      })();
    }) as unknown as typeof query;
    const reply = await new RealCoach({ query: model }).ask({ job: 'why', model: 'haiku', brief, engine: tool }, () => {});
    expect(reply.text).toBe('Develop a knight.');
    expect(tool.questions).toBe(3);
  });

  it('never shows the Player what the Coach wrote before asking the Engine', async () => {
    const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    const model = (() =>
      (async function* () {
        yield delta('Let me check Qxf2+ first. ');
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Let me check Qxf2+ first. ' }, { type: 'tool_use', id: 't1', name: ENGINE_TOOL_NAME, input: {} }] } };
        yield delta('Nxe5 leaves f2 open.');
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Nxe5 leaves f2 open.' }] } };
        // No structured output: the streamed text is the explanation.
        yield { ...result, structured_output: undefined };
      })()) as unknown as typeof query;
    let shown = '';
    const reply = await new RealCoach({ query: model }).ask({ job: 'why', model: 'haiku', brief, engine }, (d) => (shown += d));
    expect(shown).toBe('Nxe5 leaves f2 open.');
    expect(reply.text).toBe('Nxe5 leaves f2 open.');
  });

  it('streams the answer as soon as the turn moves on to it, not only once it ends', async () => {
    const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    const opens = (name: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name, input: {} } } });
    let shown = '';
    let shownBeforeTurnEnded = '';
    const model = (() =>
      (async function* () {
        yield delta('Let me check Qxf2+. ');
        yield opens(ENGINE_TOOL_NAME);
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: ENGINE_TOOL_NAME, input: {} }] } };
        yield delta('Nxe5 leaves f2 open.');
        // The turn's next block is its structured answer: the text before it is the answer, not thinking aloud.
        yield opens('StructuredOutput');
        shownBeforeTurnEnded = shown;
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Nxe5 leaves f2 open.' }, { type: 'tool_use', id: 't2', name: 'StructuredOutput', input: {} }] } };
        yield { ...result, structured_output: undefined };
      })()) as unknown as typeof query;
    const reply = await new RealCoach({ query: model }).ask({ job: 'why', model: 'haiku', brief, engine }, (d) => (shown += d));
    expect(shownBeforeTurnEnded).toBe('Nxe5 leaves f2 open.');
    expect(shown).toBe('Nxe5 leaves f2 open.');
    expect(reply.text).toBe('Nxe5 leaves f2 open.');
  });

  it('streams every turn once no question is left to ask', async () => {
    const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    const used = { ...engine, exhausted: true };
    let shown = '';
    let shownMidTurn = '';
    const model = (() =>
      (async function* () {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: ENGINE_TOOL_NAME, input: {} }] } };
        yield delta('Nxe5 ');
        shownMidTurn = shown;
        yield delta('leaves f2 open.');
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Nxe5 leaves f2 open.' }] } };
        yield { ...result, structured_output: undefined };
      })()) as unknown as typeof query;
    await new RealCoach({ query: model }).ask({ job: 'why', model: 'haiku', brief, engine: used }, (d) => (shown += d));
    expect(shownMidTurn).toBe('Nxe5 ');
  });

  it('asks the Engine at least once on a first question, and only if needed on a follow-up', async () => {
    const seen: Options[] = [];
    const coach = new RealCoach({ query: fakeQuery(seen) });
    await coach.ask({ job: 'why', model: 'haiku', brief, engine }, () => {});
    await coach.ask({ job: 'why', model: 'haiku', brief: { ...brief, summary: 'Player asked: Why Nf3? Coach said: it drops e4.' }, engine }, () => {});
    expect(seen[0]?.systemPrompt).toContain('ask the Engine at least once');
    expect(seen[1]?.systemPrompt).not.toContain('at least once');
    expect(seen[1]?.systemPrompt).toContain('This is a follow-up');
  });
});

