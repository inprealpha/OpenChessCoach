// Chooses where the tempting moves come from (ADR 0011): Maia-3 once its model file is downloaded
// and checked, Opus until then or after Maia-3 fails, and the fake in verify mode. The switch to
// Maia-3 happens on the first request after the download finishes, with no restart. Tempting moves
// only add to what the Coach discusses, so a failure gives no moves rather than an error.
import { readFileSync } from 'node:fs';
import type { TemptingMovesStatus } from '@chess-coach/shared/protocol';
import type { ModelDownloader } from './download.ts';
import { FakeTemptingMoves } from './fake.ts';
import { MaiaTemptingMoves } from './maia.ts';
import type { TemptingMoves, TemptingMovesPort, TemptingMovesRequest } from './port.ts';

export interface TemptingMovesResult extends TemptingMoves {
  source: TemptingMovesPort['name'];
  /** How long the guess took, for the Coach call log. */
  ms: number;
}

export interface LocalModel {
  downloader: ModelDownloader;
  /** Loads the checked model file; by default Maia-3 on onnxruntime's WebAssembly build. */
  load?: (model: Uint8Array) => Promise<TemptingMovesPort & { close?: () => Promise<void> }>;
  threads?: number;
}

export interface TemptingMovesOptions {
  /** Maia-3 on this desktop, once its model is downloaded. Absent in verify mode and tests. */
  local?: LocalModel;
  /** Answers until the local model is ready, or after it fails: Opus, or the fake. */
  fallback: TemptingMovesPort;
  log?: (line: string) => void;
}

export class TemptingMovesService {
  private readonly local: LocalModel | undefined;
  private readonly fallback: TemptingMovesPort;
  private readonly log: (line: string) => void;
  private maia: Promise<TemptingMovesPort & { close?: () => Promise<void> }> | undefined;
  /** Why Maia-3 was switched off for this run, after it failed to load or answer. */
  private broken: string | undefined;

  constructor(options: TemptingMovesOptions) {
    this.local = options.local;
    this.fallback = options.fallback;
    this.log = options.log ?? (() => {});
  }

  /** Verify mode's and the tests' service: the fixed fake, no model and no network. */
  static fake(fake = new FakeTemptingMoves()): TemptingMovesService {
    return new TemptingMovesService({ fallback: fake });
  }

  /** Starts the model download in the background, when this service has a local model. */
  start(): void {
    this.local?.downloader.start();
  }

  async suggest(req: TemptingMovesRequest): Promise<TemptingMovesResult> {
    const started = Date.now();
    const maia = this.ready();
    if (maia) {
      try {
        return { ...(await (await maia).suggest(req)), source: 'maia', ms: Date.now() - started };
      } catch (err) {
        if (req.signal?.aborted) throw err;
        this.switchOff(err);
      }
    }
    try {
      return { ...(await this.fallback.suggest(req)), source: this.fallback.name, ms: Date.now() - started };
    } catch (err) {
      if (req.signal?.aborted) throw err;
      this.log(`Tempting moves from ${this.fallback.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { moves: [], source: this.fallback.name, ms: Date.now() - started };
    }
  }

  /** Whether the next answer would come from this desktop's Maia-3 (or the fake), not a Claude call. */
  isLocal(): boolean {
    return this.status().source !== 'opus';
  }

  status(): TemptingMovesStatus {
    if (!this.local) return { source: this.fallback.name, model: 'off', detail: this.fallback.name === 'fake' ? 'verify mode uses fixed moves' : 'no local model' };
    const model = this.local.downloader.state();
    if (this.broken) return { source: this.fallback.name, model: 'failed', detail: `Maia-3 is switched off until the app restarts: ${this.broken}` };
    return { source: model.model === 'ready' ? 'maia' : this.fallback.name, ...model };
  }

  async close(): Promise<void> {
    await this.local?.downloader.stop();
    const maia = await this.maia?.catch(() => undefined);
    await maia?.close?.();
  }

  /** Maia-3, loaded on first use once its model file is ready; undefined until then. */
  private ready(): Promise<TemptingMovesPort> | undefined {
    if (!this.local || this.broken || this.local.downloader.state().model !== 'ready') return undefined;
    const { downloader, threads = 1 } = this.local;
    const load = this.local.load ?? ((model: Uint8Array) => MaiaTemptingMoves.load(model, threads));
    this.maia ??= load(new Uint8Array(readFileSync(downloader.path)));
    return this.maia;
  }

  private switchOff(err: unknown): void {
    this.broken = err instanceof Error ? err.message : String(err);
    this.maia = undefined;
    this.log(`Maia-3 failed, so Opus gives the tempting moves until the app restarts: ${this.broken}`);
  }
}
