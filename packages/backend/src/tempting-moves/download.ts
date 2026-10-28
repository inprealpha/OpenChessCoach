// The Maia-3 model file, downloaded in the background after the app starts (ADR 0011): from a pinned
// address, resumed after an interruption, checked against its SHA-256 before it is ever loaded, and
// retried a few times. Until it is ready the Opus side answers, so nothing waits on the download.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { TemptingMovesStatus } from '@chess-coach/shared/protocol';

export interface ModelAsset {
  /** The name files are stored under, with the first 8 characters of the SHA-256 after it. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** Maia-3 5M, converted to ONNX by data-prep/maia3-onnx-export.py and hosted as a release asset. */
export const MAIA3_5M: ModelAsset = {
  name: 'maia3-5m',
  url: 'https://github.com/inprealpha/OpenChessCoach/releases/download/maia3-5m-v1/maia3-5m.onnx',
  bytes: 20_866_685,
  sha256: '10ab0eeee51592dcf1593ccac0a8bd2d64d516e0191d384370ee74d129b472e9',
};

export type ModelState = Pick<TemptingMovesStatus, 'model' | 'detail'>;

export interface DownloaderOptions {
  /** The folder model files are kept in: `<data folder>/models`. */
  dir: string;
  asset?: ModelAsset;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Waits before the first try, so the download doesn't compete with start-up. */
  startDelayMs?: number;
  /** Waits after each failure; once they are used up, the next try is at the next start. */
  retryDelaysMs?: readonly number[];
  /** Called whenever the state changes. */
  onChange?: (state: ModelState) => void;
}

const MB = 1_000_000;

export class ModelDownloader {
  readonly asset: ModelAsset;
  private readonly dir: string;
  private readonly fetch: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly startDelayMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly onChange: (state: ModelState) => void;
  private current: ModelState = { model: 'missing', detail: 'not downloaded yet' };
  private failures = 0;
  private timer: NodeJS.Timeout | undefined;
  private abort: AbortController | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(options: DownloaderOptions) {
    this.asset = options.asset ?? MAIA3_5M;
    this.dir = options.dir;
    this.fetch = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
    this.startDelayMs = options.startDelayMs ?? 30_000;
    this.retryDelaysMs = options.retryDelaysMs ?? [60_000, 5 * 60_000, 30 * 60_000];
    this.onChange = options.onChange ?? (() => {});
  }

  /** The checked model file's path; it exists only once the download has been verified. */
  get path(): string {
    return join(this.dir, `${this.asset.name}-${this.asset.sha256.slice(0, 8)}.onnx`);
  }

  state(): ModelState {
    return this.current;
  }

  /** Checks a file left by an earlier run, and schedules a download if there is none. */
  start(): void {
    if (this.verified()) return;
    this.schedule(this.startDelayMs);
  }

  /** Stops waiting and abandons a download in progress; its partial file is kept for next time. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort?.abort();
    await this.running;
  }

  /** One try now: resolves when it has finished, whether it succeeded or failed. */
  attempt(): Promise<void> {
    this.running ??= this.download().finally(() => (this.running = undefined));
    return this.running;
  }

  private set(state: ModelState): void {
    this.current = state;
    this.onChange(state);
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.attempt(), ms);
    this.timer.unref();
  }

  /** True when the final file is there and its SHA-256 matches; a bad one is deleted. */
  private verified(): boolean {
    if (!existsSync(this.path)) return false;
    if (statSync(this.path).size === this.asset.bytes && sha256(readFileSync(this.path)) === this.asset.sha256) {
      this.set({ model: 'ready', detail: `${this.asset.name} is downloaded and checked` });
      return true;
    }
    rmSync(this.path, { force: true });
    return false;
  }

  private async download(): Promise<void> {
    if (this.stopped || this.verified()) return;
    mkdirSync(this.dir, { recursive: true });
    const unlock = this.lock();
    if (!unlock) {
      this.set({ model: 'downloading', detail: 'another copy of the app is downloading the model' });
      this.schedule(this.retryDelaysMs[0] ?? 60_000);
      return;
    }
    const part = `${this.path}.part`;
    this.abort = new AbortController();
    try {
      let have = existsSync(part) ? statSync(part).size : 0;
      if (have > this.asset.bytes) {
        rmSync(part);
        have = 0;
      }
      if (have < this.asset.bytes) have = await this.fetchInto(part, have, this.abort.signal);
      if (have !== this.asset.bytes) throw new Error(`the download stopped at ${mb(have)} of ${mb(this.asset.bytes)} MB`);
      if ((await sha256File(part)) !== this.asset.sha256) {
        rmSync(part, { force: true });
        throw new Error('the downloaded file failed its checksum');
      }
      // A file under the final name has passed its check: a half-written one never gets loaded.
      renameSync(part, this.path);
      this.removeOld();
      this.failures = 0;
      this.set({ model: 'ready', detail: `${this.asset.name} is downloaded and checked` });
      this.log(`Downloaded the ${this.asset.name} model for tempting moves.`);
    } catch (err) {
      if (this.stopped) return;
      this.failures++;
      const reason = err instanceof Error ? err.message : String(err);
      const wait = this.retryDelaysMs[this.failures - 1];
      this.set({
        model: 'failed',
        detail: wait === undefined ? `${reason}; it will try again the next time the app starts` : `${reason}; trying again in ${minutes(wait)}`,
      });
      this.log(`The ${this.asset.name} model download failed: ${reason}.`);
      if (wait !== undefined) this.schedule(wait);
    } finally {
      unlock();
      this.abort = undefined;
    }
  }

  /**
   * Fetches the rest of the file into `part`, resuming from `have` bytes with an HTTP Range request.
   * A server that ignores the range sends the whole file, which then starts again from zero.
   * Returns the size of `part` afterwards.
   */
  private async fetchInto(part: string, have: number, signal: AbortSignal): Promise<number> {
    const res = await this.fetch(this.asset.url, { signal, redirect: 'follow', headers: have > 0 ? { range: `bytes=${have}-` } : {} });
    if (res.status === 416 && have > 0) return have;
    if (res.status !== 200 && res.status !== 206) throw new Error(`the server answered ${res.status}`);
    if (!res.body) throw new Error('the server sent no file');
    const resumed = res.status === 206;
    if (resumed && !res.headers.get('content-range')?.startsWith(`bytes ${have}-`)) {
      rmSync(part, { force: true });
      throw new Error('the server sent a different part of the file than was asked for');
    }
    let size = resumed ? have : 0;
    const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    const closed = new Promise<void>((resolve, reject) => {
      out.on('close', resolve);
      out.on('error', reject);
    });
    try {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > this.asset.bytes) throw new Error('the server sent more than the model file');
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        this.set({ model: 'downloading', detail: `downloading ${this.asset.name}: ${mb(size)} of ${mb(this.asset.bytes)} MB` });
      }
    } finally {
      out.end();
      await closed;
    }
    return size;
  }

  /**
   * A lock file, so two copies of the app don't download into the same file. A lock whose process
   * is gone is taken over. Returns the release function, or undefined when another copy holds it.
   */
  private lock(): (() => void) | undefined {
    const path = join(this.dir, `${this.asset.name}.lock`);
    for (let tries = 0; tries < 2; tries++) {
      try {
        const fd = openSync(path, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => rmSync(path, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const pid = Number(readFileSync(path, 'utf8'));
        if (pid !== process.pid && isAlive(pid)) return undefined;
        rmSync(path, { force: true });
      }
    }
    return undefined;
  }

  /** Earlier versions of the model, once the new one has passed its check. */
  private removeOld(): void {
    for (const file of readdirSync(this.dir)) {
      if (file.startsWith(`${this.asset.name}-`) && file.endsWith('.onnx') && join(this.dir, file) !== this.path) rmSync(join(this.dir, file), { force: true });
    }
  }
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const mb = (bytes: number) => (bytes / MB).toFixed(1);
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : ms === 60_000 ? '1 minute' : `${Math.round(ms / 60_000)} minutes`);
