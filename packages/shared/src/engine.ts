// The Engine interface. The browser's Web Worker, for play and board analysis, and the backend's Node
// builds, for everything the Coach touches, both satisfy it (ADR 0007).
import type { Threat } from './threat.ts';

/** An Engine score from the point of view of the side to move. */
export type Score = { cp: number; mate?: undefined } | { mate: number; cp?: undefined };

export interface EngineLine {
  /** Principal variation in UCI, starting with the candidate move. */
  pv: string[];
  score: Score;
  depth: number;
}

export interface Analysis {
  fen: string;
  depth: number;
  /** Candidate lines, best first. */
  lines: EngineLine[];
}

export interface AnalyseOptions {
  /** Number of candidate lines. */
  multiPv: number;
  /** Fixed search depth. Verify mode and tests always set this. */
  depth?: number;
  /** Node limit, used for quick Engine Game replies. */
  nodes?: number;
  /** Time limit in milliseconds. */
  movetime?: number;
  /** Cancels the search: dropped if it hasn't started, stopped if it has. Either way it rejects with an EngineCancelled. */
  signal?: AbortSignal;
}

/** A search cancelled through its signal: nobody wants its result, so it has none. */
export class EngineCancelled extends Error {
  constructor() {
    super('The Engine search was cancelled.');
  }
}

export interface PlayOptions {
  /** Stockfish "Skill Level", 0 to 20. */
  skill: number;
  depth?: number;
  movetime?: number;
  /**
   * The game so far: the position it started from and the moves (UCI) that lead to the one the
   * Engine plays in. With it the Engine sees which positions have occurred, so it doesn't walk
   * into a threefold repetition when it is better, as it would from the bare position.
   */
  history?: { startFen: string; moves: readonly string[] };
}

export interface Engine {
  analyse(fen: string, options: AnalyseOptions, onProgress?: (partial: Analysis) => void): Promise<Analysis>;
  bestMove(fen: string, options: PlayOptions): Promise<string>;
  /**
   * The opponent's threat: their best move if they could move now, from a search of the position
   * with the side to move swapped. Undefined when the side to move is in check or the threat would
   * cost less than an Inaccuracy (see threat.ts).
   */
  threat(fen: string, options: AnalyseOptions): Promise<Threat | undefined>;
  stop(): void;
  dispose(): void;
}

/** Parses one UCI "info" line. Returns undefined for lines without a scored PV. */
export function parseInfoLine(line: string): (EngineLine & { multipv: number }) | undefined {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return undefined;
  const tokens = line.split(' ');
  let depth = 0;
  let multipv = 1;
  let score: Score | undefined;
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') depth = Number(tokens[++i]);
    else if (t === 'multipv') multipv = Number(tokens[++i]);
    else if (t === 'score') {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      score = kind === 'mate' ? { mate: value } : { cp: value };
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') return undefined;
    } else if (t === 'pv') {
      pv = tokens.slice(i + 1);
      break;
    }
  }
  if (!score || pv.length === 0) return undefined;
  return { depth, multipv, score, pv };
}

/** Collects UCI output for one search into an Analysis. */
export class AnalysisCollector {
  private readonly byPv = new Map<number, EngineLine>();
  private depth = 0;
  private readonly fen: string;
  constructor(fen: string) {
    this.fen = fen;
  }

  /** Returns true when the line changed the analysis. */
  push(line: string): boolean {
    const info = parseInfoLine(line);
    if (!info) return false;
    const { multipv, ...rest } = info;
    if (multipv === 1 && rest.depth > this.depth) this.depth = rest.depth;
    this.byPv.set(multipv, rest);
    return true;
  }

  snapshot(): Analysis {
    const lines = [...this.byPv.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
    return { fen: this.fen, depth: this.depth, lines };
  }
}
