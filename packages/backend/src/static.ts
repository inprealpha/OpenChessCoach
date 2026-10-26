import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Serves the built web app, falling back to index.html for client-side routes. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const rootAbs = resolve(root);
  let file = normalize(join(rootAbs, decodeURIComponent(url.pathname)));
  if (!file.startsWith(rootAbs + sep) && file !== rootAbs) {
    res.writeHead(403).end();
    return;
  }
  const found = existsSync(file) && !statSync(file).isDirectory();
  // A missing file is a 404, never the app: a tab still running the previous build asks for its
  // old chunks, and index.html in their place would fail as a script and be cached for a year.
  if (!found && (extname(url.pathname) !== '' || url.pathname.startsWith('/assets/'))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not found');
    return;
  }
  if (!found) file = join(rootAbs, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' }).end('The web app has not been built. Run `npm run build`.');
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const immutable = found && url.pathname.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}
