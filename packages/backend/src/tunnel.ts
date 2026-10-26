// Away-from-home access through a Cloudflare quick tunnel (ADR 0001). Off by default. Pairing
// applies exactly as on the LAN: the tunnel only forwards to the same port.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TunnelState } from '@chess-coach/shared/protocol';

export interface RunningTunnel {
  url: string;
  stop(): Promise<void>;
  /** Called when the tunnel process exits on its own. */
  onExit(cb: () => void): void;
}

/** Starts a tunnel to `localUrl` and resolves once its public HTTPS address is known. */
export type TunnelStarter = (localUrl: string, dataDir: string, log: (line: string) => void) => Promise<RunningTunnel>;

interface Options {
  localUrl: string;
  dataDir: string;
  onChange: (state: TunnelState) => void;
  log: (line: string) => void;
  starter?: TunnelStarter;
}

export class TunnelManager {
  private readonly options: Options;
  private current: RunningTunnel | undefined;
  private status: TunnelState = { enabled: false, status: 'off', url: null };
  private wanted = false;
  private restarts = 0;

  constructor(options: Options) {
    this.options = options;
  }

  state(): TunnelState {
    return { ...this.status };
  }

  async start(): Promise<void> {
    this.wanted = true;
    if (this.current) return;
    this.set({ enabled: true, status: 'starting', url: null });
    try {
      const starter = this.options.starter ?? startCloudflared;
      const tunnel = await starter(this.options.localUrl, this.options.dataDir, this.options.log);
      if (!this.wanted) {
        await tunnel.stop();
        return;
      }
      this.current = tunnel;
      this.restarts = 0;
      this.set({ enabled: true, status: 'running', url: tunnel.url });
      tunnel.onExit(() => {
        if (this.current !== tunnel) return;
        this.current = undefined;
        if (!this.wanted) return;
        // A quick tunnel gets a new address every time it starts; the new QR code follows the change event.
        if (this.restarts++ < 3) {
          this.options.log('The tunnel stopped; starting a new one.');
          this.start().catch(() => undefined);
        } else this.set({ enabled: true, status: 'error', url: null, error: 'The tunnel keeps stopping. Untick and tick the box to try again.' });
      });
    } catch (err) {
      this.set({ enabled: true, status: 'error', url: null, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.wanted = false;
    const t = this.current;
    this.current = undefined;
    if (t) await t.stop();
    if (this.status.status !== 'off') this.set({ enabled: false, status: 'off', url: null });
  }

  private set(state: TunnelState): void {
    this.status = state;
    this.options.onChange(this.state());
  }
}

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function cloudflaredAsset(): { name: string; archive: boolean } {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  if (process.platform === 'win32') return { name: `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe`, archive: false };
  if (process.platform === 'darwin') return { name: `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`, archive: true };
  return { name: `cloudflared-linux-${arch}`, archive: false };
}

/** Finds cloudflared on PATH or in the data folder, downloading it on first use. */
export async function ensureCloudflared(dataDir: string, log: (line: string) => void): Promise<string> {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const local = join(dataDir, 'bin', exe);
  if (existsSync(local)) return local;
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  const asset = cloudflaredAsset();
  log(`Downloading cloudflared (${asset.name}) for the away-from-home tunnel…`);
  const res = await fetch(`${RELEASES}/${asset.name}`);
  if (!res.ok || !res.body) throw new Error(`Could not download cloudflared (HTTP ${res.status}).`);
  const tmp = `${local}.download${asset.archive ? '.tgz' : ''}`;
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
  if (asset.archive) {
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', tmp, '-C', join(dataDir, 'bin')]);
      tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Could not unpack cloudflared.'))));
    });
  } else renameSync(tmp, local);
  if (process.platform !== 'win32') chmodSync(local, 0o755);
  return local;
}

export const startCloudflared: TunnelStarter = async (localUrl, dataDir, log) => {
  const bin = await ensureCloudflared(dataDir, log);
  const child: ChildProcess = spawn(bin, ['tunnel', '--no-autoupdate', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The tunnel did not start within 45 seconds.')), 45_000);
    const scan = (chunk: Buffer) => {
      const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (code ${code}) before the tunnel was ready.`));
    });
  });
  const exitCallbacks: (() => void)[] = [];
  child.on('exit', () => exitCallbacks.forEach((cb) => cb()));
  return {
    url,
    onExit: (cb) => exitCallbacks.push(cb),
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
};
