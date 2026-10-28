// One port serves the built web app, the pairing endpoint and the WebSocket (ADR 0001).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE_UNAUTHORISED,
  isClientMessage,
  PROTOCOL_VERSION,
  type ServerEvent,
  type ServerMessage,
} from '@chess-coach/shared/protocol';
import type { Clock } from './clock.ts';
import { openDb, type Db } from './db.ts';
import { AppError } from './errors.ts';
import { handlers, type AppContext, type RequestContext } from './handlers/index.ts';
import { lanAddress, pairUrl } from './network.ts';
import { Pairing, PairingRefused, type Device } from './pairing.ts';
import { serveStatic } from './static.ts';
import { CoachService } from './coach/service.ts';
import { createNodeEngine, desktopThreads } from './engine/node-engine.ts';
import { EngineService } from './engine/service.ts';
import type { Engine } from '@chess-coach/shared/engine';
import type { CoachPort } from './coach/port.ts';
import { TunnelManager, type TunnelStarter } from './tunnel.ts';
import { verifyRoutes } from './verify/routes.ts';

export interface EngineConfig {
  /** Fixed search depth for analysis; verify mode keeps it low and fixed. */
  depth: number;
  multiPv: number;
  /** Force a single thread, for repeatable verify-mode results. */
  singleThread: boolean;
}

export interface AppOptions {
  dataDir: string;
  host: string;
  port: number;
  webRoot: string;
  verify: boolean;
  coach: CoachPort;
  clock: Clock;
  version: string;
  engine: EngineConfig;
  fetch?: typeof fetch;
  tunnelStarter?: TunnelStarter;
  /** Host name to put in URLs instead of the LAN address. */
  publicHost?: string;
  log?: (line: string) => void;
  /** Starts the desktop's Engine; by default the Node build, single-threaded when `engine.singleThread` is set. */
  engineStarter?: () => Promise<Engine>;
  /** Sees every event broadcast to clients, for example to print a new QR code. */
  onEvent?: (event: ServerEvent) => void;
}

export interface RunningApp {
  port: number;
  /** Address of this install on the local network. */
  lanUrl: string;
  /** Address on this desktop. */
  localUrl: string;
  db: Db;
  pairing: Pairing;
  coach: CoachService;
  context: AppContext;
  close(): Promise<void>;
}

export async function startApp(options: AppOptions): Promise<RunningApp> {
  const db = openDb(options.dataDir);
  const pairing = new Pairing(db, options.clock);
  const sockets = new Set<WebSocket>();
  const broadcast = (event: ServerEvent) => {
    options.onEvent?.(event);
    const msg = JSON.stringify({ v: PROTOCOL_VERSION, type: 'event', event } satisfies ServerMessage);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(msg);
  };
  const coach = new CoachService(db, options.clock, options.coach, (status) => broadcast({ kind: 'coach-status', status }));
  const desktopEngine = new EngineService(
    options.engineStarter ?? (() => createNodeEngine(options.engine.singleThread ? 1 : desktopThreads())),
    { depth: options.engine.depth, multiPv: options.engine.multiPv },
  );
  const log = options.log ?? (() => {});

  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const lanHost = options.publicHost ?? (options.host === '127.0.0.1' || options.host === 'localhost' ? '127.0.0.1' : lanAddress());
  const lanUrl = `http://${lanHost}:${port}`;
  const localUrl = `http://localhost:${port}`;

  const tunnel = new TunnelManager({
    localUrl: `http://127.0.0.1:${port}`,
    dataDir: options.dataDir,
    onChange: (state) => broadcast({ kind: 'tunnel', tunnel: state }),
    log,
    ...(options.tunnelStarter ? { starter: options.tunnelStarter } : {}),
  });

  const stopping = new AbortController();
  const context: AppContext = {
    db,
    clock: options.clock,
    pairing,
    coach,
    desktopEngine,
    verify: options.verify,
    version: options.version,
    engine: options.engine,
    lanUrl,
    localUrl,
    tunnel,
    fetch: options.fetch ?? fetch,
    broadcast,
    log,
    revalidate: () => {
      for (const s of sockets) if (!pairing.verify(tokens.get(s))) s.close(CLOSE_UNAUTHORISED, 'Pairing was reset');
    },
    stopping: stopping.signal,
  };

  server.on('request', (req, res) => {
    handleHttp(context, options, req, res).catch((err: unknown) => {
      log(`HTTP error: ${String(err)}`);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the desktop.' });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const device = pairing.verify(url.searchParams.get('token'));
    if (!device) {
      // Refused before the upgrade, whichever route the connection came by (ADR 0001).
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') as string;
    wss.handleUpgrade(req, socket, head, (ws) => {
      tokens.set(ws, token);
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      attachSocket(context, ws, device);
    });
  });

  const settings = (await import('./settings.ts')).getSettings(db);
  if (settings.tunnelEnabled) tunnel.start().catch((err: unknown) => log(`Tunnel failed to start: ${String(err)}`));

  let closed = false;
  return {
    port,
    lanUrl,
    localUrl,
    db,
    pairing,
    coach,
    context,
    close: async () => {
      if (closed) return;
      closed = true;
      await tunnel.stop();
      for (const s of sockets) s.terminate();
      stopping.abort();
      wss.close();
      // Close open keep-alive connections at once, or close() waits for a browser that keeps polling.
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closing;
      db.close();
    },
  };
}

function attachSocket(context: AppContext, ws: WebSocket, device: Device): void {
  const inflight = new Map<string, AbortController>();
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  ws.on('close', () => {
    for (const c of inflight.values()) c.abort();
  });
  ws.on('message', (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      send({ v: PROTOCOL_VERSION, id: '', type: 'error', ok: false, code: 'bad-request', message: 'Messages must be JSON.' });
      return;
    }
    if (!isClientMessage(parsed)) {
      send({ v: PROTOCOL_VERSION, id: '', type: 'error', ok: false, code: 'bad-request', message: 'Messages need v, id and type.' });
      return;
    }
    const { id, type, v } = parsed;
    if (v !== PROTOCOL_VERSION) {
      send({ v: PROTOCOL_VERSION, id, type: 'error', ok: false, code: 'version-mismatch', message: `This desktop speaks protocol ${PROTOCOL_VERSION}. Reload the app.` });
      return;
    }
    const handler = (handlers as Record<string, (req: unknown, ctx: RequestContext) => Promise<unknown>>)[type];
    if (!handler) {
      send({ v: PROTOCOL_VERSION, id, type: 'error', ok: false, code: 'unknown-type', message: `Unknown message type ${type}.` });
      return;
    }
    if (!context.pairing.verify(tokenOf(ws))) {
      ws.close(CLOSE_UNAUTHORISED, 'Pairing was reset');
      return;
    }
    const abort = new AbortController();
    inflight.set(id, abort);
    const ctx: RequestContext = {
      app: context,
      device,
      signal: abort.signal,
      connected: () => ws.readyState === ws.OPEN,
      delta: (text, part) => send({ v: PROTOCOL_VERSION, id, type: 'coach.delta', text, ...(part !== undefined ? { part } : {}) }),
      progress: (done, total) => send({ v: PROTOCOL_VERSION, id, type: 'progress', done, total }),
      setToken: (token) => tokens.set(ws, token),
    };
    handler(parsed, ctx)
      .then((result) => send({ v: PROTOCOL_VERSION, id, type: 'result', ok: true, data: result }))
      .catch((err: unknown) => {
        if (err instanceof AppError) send({ v: PROTOCOL_VERSION, id, type: 'error', ok: false, code: err.code, message: err.message });
        else {
          context.log(`Request ${type} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          send({ v: PROTOCOL_VERSION, id, type: 'error', ok: false, code: 'internal', message: 'Something went wrong on the desktop.' });
        }
      })
      .finally(() => inflight.delete(id));
  });
}

const tokens = new WeakMap<WebSocket, string>();
function tokenOf(ws: WebSocket): string | undefined {
  return tokens.get(ws);
}

async function handleHttp(context: AppContext, options: AppOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Cross-origin isolation lets Stockfish run multi-threaded where the browser allows it (ADR 0003).
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url ?? '/', 'http://x');

  if (url.pathname === '/api/health' && req.method === 'GET') {
    // In verify mode the process id lets coachctl doctor check the port belongs to its own run.
    json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, version: context.version, verify: context.verify, ...(context.verify ? { pid: process.pid } : {}) });
    return;
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    json(res, 200, { protocol: PROTOCOL_VERSION, verify: context.verify, engine: context.engine });
    return;
  }
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const body = (await readJson(req)) as { code?: unknown; deviceName?: unknown };
    const name = String(body.deviceName ?? 'Device');
    try {
      const result = context.pairing.pair(String(body.code ?? ''), name);
      context.log(`Paired a new device (${name}).`);
      // A screen showing the QR code, such as first run's phone step, says when the phone has paired.
      context.broadcast({ kind: 'device-paired' });
      json(res, 200, result);
    } catch (err) {
      if (err instanceof PairingRefused) json(res, 401, { error: err.message });
      else throw err;
    }
    return;
  }
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const device = context.pairing.verify(bearer(req));
    if (device) json(res, 200, { deviceId: device.id, deviceName: device.name });
    else json(res, 401, { error: 'This device is not paired. Scan the QR code shown on the desktop.' });
    return;
  }
  if (url.pathname.startsWith('/__verify/')) {
    if (!context.verify) {
      json(res, 404, { error: 'Not found' });
      return;
    }
    if (!context.pairing.verify(bearer(req))) {
      json(res, 401, { error: 'Pair first: verify routes need a device token.' });
      return;
    }
    await verifyRoutes(context, url, req, res);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, 404, { error: 'Not found' });
    return;
  }
  serveStatic(options.webRoot, req, res);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export { pairUrl };
