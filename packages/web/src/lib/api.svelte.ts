// The connection to the desktop: pairing over HTTP, then the one protocol over a WebSocket.
import {
  CLOSE_UNAUTHORISED,
  PROTOCOL_VERSION,
  type CoachStatus,
  type ErrorCode,
  type PhoneStatus,
  type RequestBody,
  type RequestType,
  type ResponseBody,
  type ServerMessage,
  type TunnelState,
} from '@chess-coach/shared/protocol';
import { loadToken, saveToken, store } from './storage.ts';
import { thisDeviceName } from './this-device.ts';

export type ConnectionState = 'starting' | 'online' | 'offline' | 'unpaired';

export interface EngineConfig {
  depth: number;
  multiPv: number;
  singleThread: boolean;
}

export class ApiError extends Error {
  readonly code: ErrorCode | 'offline';
  constructor(code: ErrorCode | 'offline', message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: ApiError) => void;
  onDelta?: (text: string, part?: number, status?: string) => void;
  onProgress?: (done: number, total: number) => void;
}

const OFFLINE_REASON = 'Your desktop can’t be reached, so the Coach is unavailable. The board and the Engine still work.';

/** How long the connection may stay quiet before the app checks that the desktop is still there. */
const QUIET_MS = 10_000;
/** How long the desktop has to answer that check before the connection counts as lost. */
const ANSWER_MS = 5_000;
/** How long a reconnect waits for the desktop before trying again later. */
const CONNECT_MS = 10_000;

class Api {
  state = $state<ConnectionState>('starting');
  coach = $state<CoachStatus>({ state: 'unavailable', reason: 'Connecting to your desktop…' });
  verify = $state(false);
  tunnel = $state<TunnelState | null>(null);
  engine = $state<EngineConfig>({ depth: 16, multiPv: 5, singleThread: false });
  pairError = $state<string | null>(null);
  /** Increments every time the connection comes back, so screens can resync. */
  reconnects = $state(0);
  /** Increments every time pairing is reset, so a screen showing the QR code shows the new one and asks for the phone again. */
  pairingResets = $state(0);
  /** Hears whether a phone is paired each time a device pairs, so a screen showing the QR code says when the phone has paired. */
  onDevicePaired: ((phone: PhoneStatus) => void) | null = null;

  private token: string | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private onlineWaiters: (() => void)[] = [];
  /** When the desktop last sent anything, and when the app last checked on it without an answer yet. */
  private heard = 0;
  private checkSent: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  get coachReady(): boolean {
    return this.state === 'online' && this.coach.state === 'ready';
  }

  async init(): Promise<void> {
    await this.loadConfig();
    // A pairing link opened in a tab that is already showing the app arrives as a hash change.
    window.addEventListener('hashchange', () => {
      const code = takePairCode();
      if (code && this.state === 'unpaired') void this.pair(code);
    });
    // Back on screen (a phone unlocked) or back on a network: don't wait for the next retry.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.wake();
    });
    window.addEventListener('online', () => this.wake());
    const pairCode = takePairCode();
    if (pairCode) {
      await this.pair(pairCode);
    } else {
      this.token = await loadToken();
    }
    if (!this.token) {
      this.state = 'unpaired';
      return;
    }
    await this.connect();
  }

  async pair(code: string): Promise<boolean> {
    this.pairError = null;
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName: thisDeviceName }),
      });
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        this.pairError = body.error ?? 'Pairing failed.';
        this.token = await loadToken();
        return false;
      }
      this.token = body.token;
      await saveToken(body.token);
      if (this.state !== 'starting') await this.connect();
      return true;
    } catch {
      this.pairError = 'Your desktop can’t be reached. Check that the coach is running and you are on the same Wi-Fi.';
      this.token = await loadToken();
      return false;
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (res.ok) {
        const config = (await res.json()) as { verify: boolean; engine: EngineConfig };
        this.verify = config.verify;
        this.engine = config.engine;
        await store.set('config', config);
        return;
      }
    } catch {
      // offline: fall back to the last config we saw
    }
    const cached = await store.get<{ verify: boolean; engine: EngineConfig }>('config');
    if (cached) {
      this.verify = cached.verify;
      this.engine = cached.engine;
    }
  }

  private async connect(): Promise<void> {
    // wake() may call in while a retry is already on its way.
    if (this.connecting) return;
    clearTimeout(this.retryTimer);
    let res: Response;
    this.connecting = true;
    // A sleeping desktop may never answer at all. (Not AbortSignal.timeout: Safari has it only from 16.)
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CONNECT_MS);
    try {
      res = await fetch('/api/session', { headers: { authorization: `Bearer ${this.token}` }, cache: 'no-store', signal: abort.signal });
    } catch {
      this.goOffline();
      return;
    } finally {
      clearTimeout(timer);
      this.connecting = false;
    }
    if (res.status === 401) {
      await this.unpair();
      return;
    }
    if (!res.ok) {
      this.goOffline();
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token ?? '')}`);
    this.ws = ws;
    ws.onopen = async () => {
      this.retryMs = 500;
      this.state = 'online';
      this.watch(ws);
      try {
        const hello = await this.request('hello', { client: 'web', deviceName: thisDeviceName });
        this.verify = hello.verify;
        this.coach = hello.coach;
        this.reconnects++;
        this.onlineWaiters.splice(0).forEach((w) => w());
      } catch {
        // handled by close
      }
    };
    ws.onmessage = (ev) => {
      this.heard = Date.now();
      this.checkSent = null;
      this.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    };
    ws.onclose = (ev) => this.lost(ws, ev.code);
  }

  /** The connection is gone: every request waiting on it fails with the offline reason, and reconnecting starts. */
  private lost(ws: WebSocket, code?: number): void {
    if (this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.watchdog);
    for (const p of this.pending.values()) p.reject(new ApiError('offline', OFFLINE_REASON));
    this.pending.clear();
    if (code === CLOSE_UNAUTHORISED) void this.unpair();
    else this.goOffline();
  }

  /**
   * A desktop that sleeps or drops off the Wi-Fi leaves the connection open but silent, and the
   * browser may not notice for minutes. While the page is on screen, a connection quiet for
   * QUIET_MS gets a cheap request; no answer within ANSWER_MS means the desktop is gone. Long jobs
   * such as a Review are not cut short: the desktop answers the check while it works on them.
   */
  private watch(ws: WebSocket): void {
    this.heard = Date.now();
    this.checkSent = null;
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.ws !== ws || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (this.checkSent === null) {
        if (now - this.heard >= QUIET_MS) this.check(ws);
      } else if (now - this.checkSent >= ANSWER_MS) {
        this.lost(ws);
        ws.close();
      }
    }, 1_000);
  }

  /** Any message from the desktop counts as the answer; the settings are a cheap read. */
  private check(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.checkSent = Date.now();
    this.request('settings.get', {}).catch(() => {
      // a lost connection is handled by lost()
    });
  }

  /** Reconnects at once if offline, or checks an open connection that may have died while the page was away. */
  private wake(): void {
    if (this.state === 'offline' && !this.ws) {
      this.retryMs = 500;
      void this.connect();
    } else if (this.state === 'online' && this.ws) this.check(this.ws);
  }

  private goOffline(): void {
    this.state = 'offline';
    this.coach = { state: 'unavailable', reason: OFFLINE_REASON };
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
  }

  private async unpair(): Promise<void> {
    this.token = null;
    await saveToken(null);
    this.state = 'unpaired';
    this.coach = { state: 'unavailable', reason: 'This device is not paired.' };
  }

  /** Resolves once the desktop is reachable. */
  whenOnline(): Promise<void> {
    if (this.state === 'online') return Promise.resolve();
    return new Promise((resolve) => this.onlineWaiters.push(resolve));
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'event') {
      const e = msg.event;
      if (e.kind === 'coach-status') this.coach = e.status;
      if (e.kind === 'tunnel') this.tunnel = e.tunnel;
      if (e.kind === 'device-paired') this.onDevicePaired?.(e.phone);
      if (e.kind === 'pairing-reset') this.pairingResets++;
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'coach.delta') {
      p.onDelta?.(msg.text, msg.part, msg.status);
      return;
    }
    if (msg.type === 'progress') {
      p.onProgress?.(msg.done, msg.total);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'result') p.resolve(msg.data);
    else p.reject(new ApiError(msg.code, msg.message));
  }

  request<K extends RequestType>(
    type: K,
    body: RequestBody<K>,
    onDelta?: (text: string, part?: number, status?: string) => void,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ResponseBody<K>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new ApiError('offline', OFFLINE_REASON));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, ...(onDelta ? { onDelta } : {}), ...(onProgress ? { onProgress } : {}) });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, type, ...body }));
    });
  }

  /** Called after this device reset pairing and got a fresh token. */
  async adoptToken(token: string): Promise<void> {
    this.token = token;
    await saveToken(token);
  }
}

export const api = new Api();

/** Reads the code from a pairing link (#pair=CODE) and takes it out of the address bar. */
function takePairCode(): string | null {
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair');
  if (code) history.replaceState(null, '', `${location.pathname}#/`);
  return code;
}
