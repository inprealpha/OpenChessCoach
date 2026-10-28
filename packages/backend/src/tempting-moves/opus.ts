// The tempting moves from Opus, until the Maia-3 model is downloaded or when it fails (ADR 0011).
// Opus caught 54% of real players' quick mistakes in its three guesses, against 69% for Maia-3
// (docs/research/human-move-prediction.md). The call is set up like the real Coach's: no tools, no
// MCP servers (the claude.ai account's connectors included) and no settings from disk.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { playSan, playUci, turnOf } from '@chess-coach/shared/chess';
import { isWindowsShim } from '../claude-check.ts';
import { gamePositions } from './maia.ts';
import type { CoachUsage } from '@chess-coach/shared/coach/types';
import type { TemptingMoves, TemptingMovesPort, TemptingMovesRequest } from './port.ts';

export interface OpusTemptingMovesOptions {
  /** Path to the `claude` executable the owner logged in with. */
  claudePath?: string;
  /** The Agent SDK's `query`; tests pass their own to see what is sent. */
  query?: typeof query;
}

const SYSTEM_PROMPT = 'You predict the moves human chess players make in online games. Answer only with the JSON asked for.';
const SCHEMA = {
  type: 'object',
  properties: { moves: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } },
  required: ['moves'],
  additionalProperties: false,
} as const;

/**
 * The research's "instinct" prompt: the position, the last six moves, and a request for the moves
 * that jump out at a glance. It says nothing about the player's level, as in the research.
 */
export function instinctPrompt(startFen: string, moves: readonly string[], count: number): string {
  const fens = gamePositions(startFen, moves);
  const fen = fens.at(-1)!;
  const side = turnOf(fen) === 'white' ? 'White' : 'Black';
  const from = Math.max(0, moves.length - 6);
  const recent = moves.slice(from).map((uci, i) => {
    const before = fens[from + i]!;
    const san = playUci(before, uci)!.san;
    const number = before.split(' ')[5];
    if (turnOf(before) === 'white') return `${number}. ${san}`;
    return i === 0 ? `${number}... ${san}` : san;
  });
  return [
    'This position comes from a rated online game between two human players.',
    `FEN: ${fen}`,
    `${side} to move.`,
    ...(recent.length ? [`The last moves were: ${recent.join(' ')}`] : []),
    '',
    `The human playing ${side} moved here within a few seconds, on instinct, without calculating.`,
    `Which ${count} moves would jump out at them first, the ones a player reaches for at a glance? Rank them, most likely first.`,
    'Predict the instinctive move, not necessarily the best move. Give each move in SAN, like Nf3, exd5 or O-O.',
  ].join('\n');
}

export class OpusTemptingMoves implements TemptingMovesPort {
  readonly name = 'opus' as const;
  private readonly claudePath: string | undefined;
  private readonly query: typeof query;

  constructor(options: OpusTemptingMovesOptions = {}) {
    this.claudePath = options.claudePath;
    this.query = options.query ?? query;
  }

  async suggest(req: TemptingMovesRequest): Promise<TemptingMoves> {
    const started = Date.now();
    const count = req.count ?? 3;
    const fen = gamePositions(req.startFen, req.moves).at(-1)!;
    const abort = new AbortController();
    req.signal?.addEventListener('abort', () => abort.abort());
    const stream = this.query({
      prompt: instinctPrompt(req.startFen, req.moves, count),
      options: {
        model: 'opus',
        effort: 'medium',
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        cwd: tmpdir(),
        env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        abortController: abort,
        outputFormat: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> },
        ...(this.claudePath && !isWindowsShim(this.claudePath) ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      },
    });
    let answer: unknown;
    let usage: CoachUsage | undefined;
    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) throw new Error(`Opus stopped early (${message.subtype}).`);
        answer = (message as { structured_output?: { moves?: unknown } }).structured_output?.moves;
        // As the real Coach reports a call, so the Coach call log shows what each guess cost.
        const u = (message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
        usage = {
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
          turns: (message as { num_turns?: number }).num_turns ?? 1,
          ms: Date.now() - started,
          costUsd: (message as { total_cost_usd?: number }).total_cost_usd ?? 0,
          models: Object.keys((message as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}),
        };
      }
    }
    return { moves: legalOnly(fen, Array.isArray(answer) ? answer : [], count), ...(usage ? { usage } : {}) };
  }
}

/** The answer's moves that are legal here, as UCI, without repeats. Opus gets 2% of moves wrong. */
export function legalOnly(fen: string, answer: readonly unknown[], count: number): string[] {
  const out: string[] = [];
  for (const text of answer) {
    if (typeof text !== 'string') continue;
    const clean = text.trim().replace(/^\d+\.+\s*/, '').replace(/[!?]+$/, '').replaceAll('0', 'O');
    const uci = playSan(fen, clean)?.uci ?? playUci(fen, text.trim().toLowerCase())?.uci;
    if (uci && !out.includes(uci)) out.push(uci);
  }
  return out.slice(0, count);
}
