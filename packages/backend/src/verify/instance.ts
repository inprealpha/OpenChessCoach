// A disposable verify-mode instance (ADR 0006): fake Coach, fake clock, fixed-depth Engine,
// a fresh data folder with seeded data, and a port the OS picks so it never meets the owner's
// own instance. It counts as ready only after a pairing handshake succeeds.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoachClient, pairDevice } from '../client.ts';
import { FakeClock } from '../clock.ts';
import { FakeCoach } from '../coach/fake.ts';
import { openDb } from '../db.ts';
import { appVersion, webRoot } from '../runtime.ts';
import { startApp, type AppOptions, type RunningApp } from '../server.ts';
import type { TunnelStarter } from '../tunnel.ts';
import type { CoachPort } from '../coach/port.ts';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { TemptingMovesService } from '../tempting-moves/service.ts';
import { recordedFetch } from './recorded-sites.ts';
import { seed, type Seed } from './seed.ts';

/** Verify mode's Engine: low and fixed, one thread, so a position always gets the same evaluation. */
export const VERIFY_ENGINE = { depth: 10, multiPv: 5, singleThread: true } as const;

export interface VerifyOptions {
  seed?: Seed;
  /** Data folder; a new temporary one by default. */
  dataDir?: string;
  port?: number;
  host?: string;
  webRoot?: string;
  fetch?: typeof fetch;
  tunnelStarter?: TunnelStarter;
  chunkDelayMs?: number;
  log?: (line: string) => void;
  /** Use this Coach instead of the fake one: only the desktop real-Coach check does. */
  coachPort?: CoachPort;
  /** Where the tempting moves come from; the fixed fake by default (ADR 0011). */
  temptingMoves?: TemptingMovesService;
}

export interface VerifyInstance {
  app: RunningApp;
  url: string;
  code: string;
  /** A device token from the readiness handshake, for coachctl and the verify routes. */
  token: string;
  dataDir: string;
  /** The fake Coach, unless a coachPort was given. */
  coach: FakeCoach;
  clock: FakeClock;
  stop(options?: { keepData?: boolean }): Promise<void>;
}

/** A tunnel stand-in: verify mode never opens a real public address. */
export const fakeTunnelStarter: TunnelStarter = async () => ({
  url: 'https://verify-mode.trycloudflare.com',
  stop: async () => {},
  onExit: () => {},
});

/** The fake Coach's recorded replies (see recordings/coach.json): the seeded game's Review overview. */
export function coachRecordings(): Record<string, CoachRawReply> {
  return (JSON.parse(readFileSync(new URL('./recordings/coach.json', import.meta.url), 'utf8')) as { replies: Record<string, CoachRawReply> }).replies;
}

export async function startVerifyInstance(options: VerifyOptions = {}): Promise<VerifyInstance> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'chess-coach-verify-'));
  const clock = new FakeClock();
  const coach = new FakeCoach({ chunkDelayMs: options.chunkDelayMs ?? 5, recordings: coachRecordings() });
  const seeded = openDb(dataDir);
  seed(seeded, clock, options.seed ?? 'default');
  seeded.close();

  const appOptions: AppOptions = {
    dataDir,
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    webRoot: options.webRoot ?? webRoot(),
    verify: true,
    coach: options.coachPort ?? coach,
    clock,
    version: appVersion(),
    engine: VERIFY_ENGINE,
    tunnelStarter: options.tunnelStarter ?? fakeTunnelStarter,
    log: options.log ?? (() => {}),
    // Imports by username answer from recordings (see recordings/sites.json), never the network.
    fetch: options.fetch ?? recordedFetch(),
    ...(options.temptingMoves ? { temptingMoves: options.temptingMoves } : {}),
  };
  const app = await startApp(appOptions);
  const url = `http://127.0.0.1:${app.port}`;

  // Ready means usable: a device can pair and talk to the backend over the WebSocket.
  const token = await pairDevice(url, app.pairing.code, 'verify-handshake');
  const client = await CoachClient.connect(url, token);
  const hello = await client.request('hello', { client: 'verify-handshake' });
  await client.close();
  if (!hello.verify) throw new Error('The instance is not in verify mode.');

  return {
    app,
    url,
    code: app.pairing.code,
    token,
    dataDir,
    coach,
    clock,
    async stop(stopOptions = {}) {
      await app.close();
      if (!stopOptions.keepData && !options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
