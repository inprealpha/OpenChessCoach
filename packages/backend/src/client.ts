// A client for the app's WebSocket protocol, used exactly as the web app uses it: coachctl,
// verify mode's pairing handshake and the protocol tests all go through here.
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type ErrorCode,
  type RequestBody,
  type RequestType,
  type ResponseBody,
  type ReviewPart,
  type ServerEvent,
  type ServerMessage,
} from '@chess-coach/shared/protocol';

/** A protocol error code, or a failure to pair or stay connected. */
export type ClientErrorCode = ErrorCode | 'unauthorised';

export class ProtocolError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  onDelta?: (text: string, part?: ReviewPart, status?: string) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Exchanges a pairing code for a device token, as the pairing screen does. */
export async function pairDevice(baseUrl: string, code: string, deviceName = 'coachctl'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new ProtocolError('unauthorised', body.error ?? `Pairing failed with HTTP ${res.status}.`);
  return body.token;
}

export class CoachClient {
  readonly events: ServerEvent[] = [];
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closeInfo: { code: number; reason: string } | undefined;
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        for (const p of this.pending.values()) p.reject(new ProtocolError('unauthorised', `Connection closed (${code}).`));
        this.pending.clear();
        resolve(this.closeInfo);
      });
    });
    ws.on('message', (data) => this.receive(String(data)));
  }

  /** Opens the socket. Rejects with the HTTP status when the token is refused. */
  static connect(baseUrl: string, token: string): Promise<CoachClient> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new CoachClient(ws)));
      ws.once('unexpected-response', (_req, res) => {
        reject(new ProtocolError('unauthorised', `The desktop refused the connection (HTTP ${res.statusCode}).`));
        ws.terminate();
      });
      ws.once('error', (err) => reject(err));
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  request<K extends RequestType>(
    type: K,
    body: RequestBody<K>,
    onDelta?: (text: string, part?: ReviewPart, status?: string) => void,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ResponseBody<K>> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new ProtocolError('unauthorised', 'The connection is closed.'));
        return;
      }
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, ...(onDelta ? { onDelta } : {}), ...(onProgress ? { onProgress } : {}) });
      this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, type, ...body }));
    });
  }

  /** Sends raw text, for tests of malformed messages. */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  close(): Promise<{ code: number; reason: string }> {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    return this.closed;
  }

  private receive(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'event') {
      this.events.push(msg.event);
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
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new ProtocolError(msg.code, msg.message));
  }
}
