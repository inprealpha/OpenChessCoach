// Serving the built web app: client-side routes fall back to index.html, but a missing file never
// does. A tab left open across an update asks for the previous build's chunks; a 200 with the
// HTML, cached as immutable, would break that tab and stay in caches for a year.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStatic } from '../src/static.ts';

let server: Server;
let url = '';

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-root-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>OpenChessCoach</title>');
  writeFileSync(join(root, 'assets', 'index-NEWHASH.js'), 'export {};');
  writeFileSync(join(root, 'sw.js'), '// the service worker');
  server = createServer((req, res) => serveStatic(root, req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe('the web app’s files', () => {
  it('serves a built asset as immutable', async () => {
    const res = await fetch(`${url}/assets/index-NEWHASH.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers a missing asset, such as the previous build’s Lesson chunk, with a 404 nobody caches', async () => {
    const res = await fetch(`${url}/assets/italian-game-OLDHASH.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers any other missing file with a 404 too', async () => {
    const res = await fetch(`${url}/pieces/wQ-old.svg`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves index.html for the app’s own pages, never cached as immutable', async () => {
    for (const path of ['/', '/index.html', '/settings']) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>OpenChessCoach</title>');
    }
  });

  it('serves the service worker uncached, so an update reaches the device', async () => {
    const res = await fetch(`${url}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('refuses a path outside the web app', async () => {
    const res = await fetch(`${url}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
  });
});
