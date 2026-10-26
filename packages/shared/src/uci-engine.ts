// Drives any Stockfish build over the UCI protocol: the WebAssembly Worker in the browser and the
// same builds under Node on the backend (ADR 0007), so both grade a position the same way.
import { AnalysisCollector, type AnalyseOptions, type Analysis, type Engine, type PlayOptions } from './engine.ts';
import { findThreat, type Threat } from './threat.ts';

interface Job {
  run: () => void;
  cancel: () => void;
}

export interface UciTransport {
  send(cmd: string): void;
  /** Registers the handler for every line the Engine prints. */
  listen(handler: (line: string) => void): void;
  /** Registers the handler for a transport that fails, for example a Worker that can't load. */
  onError?(handler: (error: Error) => void): void;
  close(): void;
}

export interface UciEngineOptions {
  threads: number;
  /** Reset the Engine's memory before every search so results repeat exactly (verify mode). */
  deterministic: boolean;
  /** How long the Engine may take to start before it counts as failed. */
  startTimeoutMs?: number;
}

/** The Engine could not be started, for example because the browser refused its memory. */
export class EngineStartError extends Error {}

export class UciEngine implements Engine {
  private readonly transport: UciTransport;
  private readonly ready: Promise<void>;
  private listener: ((line: string) => void) | undefined;
  private queue: Job[] = [];
  private busy = false;
  protected readonly options: UciEngineOptions;

  constructor(transport: UciTransport, options: UciEngineOptions) {
    this.transport = transport;
    this.options = options;
    transport.listen((line) => this.listener?.(line));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EngineStartError('The Engine did not start in time.')), options.startTimeoutMs ?? 30_000);
      transport.onError?.((error) => {
        clearTimeout(timer);
        reject(new EngineStartError(error.message));
      });
      this.listener = (line) => {
        if (line === 'uciok') {
          if (options.threads > 1) this.send(`setoption name Threads value ${options.threads}`);
          this.send('setoption name Hash value 16');
          this.send('isready');
        }
        if (line === 'readyok') {
          clearTimeout(timer);
          this.listener = undefined;
          resolve();
        }
      };
      this.send('uci');
    });
    // Callers see a failed start through whenReady() or their own search.
    this.ready.catch(() => undefined);
  }

  /** Resolves once the Engine answers, or rejects with an EngineStartError. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private send(cmd: string): void {
    this.transport.send(cmd);
  }

  private enqueue(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    job.run();
  }

  private done(): void {
    this.busy = false;
    this.pump();
  }

  async analyse(fen: string, options: AnalyseOptions, onProgress?: (partial: Analysis) => void): Promise<Analysis> {
    await this.ready;
    return new Promise((resolve) => {
      const collector = new AnalysisCollector(fen);
      this.enqueue({
        run: () => {
          this.listener = (line) => {
            if (collector.push(line) && onProgress) onProgress(collector.snapshot());
            if (line.startsWith('bestmove')) {
              this.listener = undefined;
              resolve(collector.snapshot());
              this.done();
            }
          };
          if (this.options.deterministic) this.send('ucinewgame');
          this.send(`setoption name MultiPV value ${options.multiPv}`);
          this.send(`position fen ${fen}`);
          this.send(goCommand(options));
        },
        cancel: () => resolve(collector.snapshot()),
      });
    });
  }

  async bestMove(fen: string, options: PlayOptions): Promise<string> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.enqueue({
        run: () => {
          this.listener = (line) => {
            if (line.startsWith('bestmove')) {
              this.listener = undefined;
              const move = line.split(' ')[1];
              this.send('setoption name Skill Level value 20');
              this.done();
              if (move && move !== '(none)') resolve(move);
              else reject(new Error('The Engine has no move in this position.'));
            }
          };
          if (this.options.deterministic) this.send('ucinewgame');
          this.send('setoption name MultiPV value 1');
          this.send(`setoption name Skill Level value ${options.skill}`);
          this.send(positionCommand(fen, options.history));
          this.send(options.depth ? `go depth ${options.depth}` : `go movetime ${options.movetime ?? 300}`);
        },
        cancel: () => reject(new Error('cancelled')),
      });
    });
  }

  /** The opponent's threat, from two searches at these options: the position, and the position after a null move (one line). */
  threat(fen: string, options: AnalyseOptions): Promise<Threat | undefined> {
    return findThreat((f, multiPv) => this.analyse(f, multiPv ? { ...options, multiPv } : options), fen);
  }

  /** Stops the current search; its result resolves with what was found so far. Queued work is dropped. */
  stop(): void {
    for (const job of this.queue.splice(0)) job.cancel();
    if (this.busy) this.send('stop');
  }

  dispose(): void {
    this.transport.close();
  }
}

/** The position to play from: the game from its start, when known, so the Engine sees repetitions. */
function positionCommand(fen: string, history: PlayOptions['history']): string {
  return history?.moves.length ? `position fen ${history.startFen} moves ${history.moves.join(' ')}` : `position fen ${fen}`;
}

function goCommand(o: AnalyseOptions): string {
  if (o.depth) return `go depth ${o.depth}`;
  if (o.nodes) return `go nodes ${o.nodes}`;
  return `go movetime ${o.movetime ?? 1000}`;
}
