// ADR 0001: nobody without the pairing code reaches the backend, over the LAN or the tunnel.
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLOSE_UNAUTHORISED, PROTOCOL_VERSION } from '@chess-coach/shared/protocol';
import { CoachClient, pairDevice, ProtocolError } from '../src/client.ts';
import { client, instance, rows } from './helpers.ts';

function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', reject);
  });
}

describe('pairing', () => {
  it('refuses a connection without a token or with a wrong one', async () => {
    const app = await instance();
    const ws = app.url.replace('http', 'ws');
    expect(await upgradeStatus(`${ws}/ws`)).toBe(401);
    expect(await upgradeStatus(`${ws}/ws?token=wrong`)).toBe(401);
    expect(await upgradeStatus(`${ws}/ws?token=${app.token}`)).toBe(101);
    const session = await fetch(`${app.url}/api/session`);
    expect(session.status).toBe(401);
  });

  it('refuses the same way when the request comes through the tunnel', async () => {
    const app = await instance();
    const tunnelHost = { host: 'verify-mode.trycloudflare.com', 'x-forwarded-proto': 'https' };
    expect(await upgradeStatus(`${app.url.replace('http', 'ws')}/ws`, tunnelHost)).toBe(401);
    const res = await fetch(`${app.url}/api/session`, { headers: tunnelHost });
    expect(res.status).toBe(401);
    const verify = await fetch(`${app.url}/__verify/db?table=devices`, { headers: tunnelHost });
    expect(verify.status).toBe(401);
  });

  it('refuses a wrong code and locks out after five in a minute', async () => {
    const app = await instance();
    for (let i = 0; i < 5; i++) await expect(pairDevice(app.url, 'AAAAAAAAAAAA')).rejects.toThrow('wrong or has been reset');
    await expect(pairDevice(app.url, app.code)).rejects.toThrow('Too many wrong pairing codes');
    app.clock.advance(61_000);
    await expect(pairDevice(app.url, app.code)).resolves.toMatch(/.{20,}/);
  });

  it('stores only a hash of each device token', async () => {
    const app = await instance();
    const token = await pairDevice(app.url, app.code, 'phone');
    const devices = rows<{ name: string; token_hash: string }>(app, 'SELECT name, token_hash FROM devices');
    expect(devices.map((d) => d.name)).toContain('phone');
    expect(JSON.stringify(devices)).not.toContain(token);
  });

  it('a reset revokes every device, closes their sockets and changes the code', async () => {
    const app = await instance();
    const phone = await pairDevice(app.url, app.code, 'phone');
    const phoneClient = await client(app, phone);
    const desktop = await client(app);
    const oldCode = app.app.pairing.code;

    const { token } = await desktop.request('pairing.reset', {});
    const closed = await phoneClient.closed;
    expect(closed.code).toBe(CLOSE_UNAUTHORISED);
    expect(app.app.pairing.code).not.toBe(oldCode);
    await expect(pairDevice(app.url, oldCode)).rejects.toBeInstanceOf(ProtocolError);
    await expect(CoachClient.connect(app.url, phone)).rejects.toBeInstanceOf(ProtocolError);
    // The device that asked for the reset keeps working with its fresh token.
    const fresh = await client(app, token);
    expect((await fresh.request('hello', { client: 'test' })).verify).toBe(true);
  });

  it('re-checks the token on every message', async () => {
    const app = await instance();
    const phone = await pairDevice(app.url, app.code, 'phone');
    const c = await client(app, phone);
    app.app.db.prepare("UPDATE devices SET revoked_at = '2026-01-01' WHERE name = 'phone'").run();
    await expect(c.request('profile.get', {})).rejects.toThrow();
    expect((await c.closed).code).toBe(CLOSE_UNAUTHORISED);
  });

  it('answers malformed and unknown messages with an error, not a crash', async () => {
    const app = await instance();
    const c = await client(app);
    await expect(c.request('nope' as 'hello', { client: 'x' })).rejects.toMatchObject({ code: 'unknown-type' });
    c.sendRaw('not json');
    expect((await c.request('hello', { client: 'x' })).protocol).toBe(PROTOCOL_VERSION);
  });
});
