// Recorded Lichess and chess.com responses for verify mode and the tests: the import code runs
// for real, but nothing reaches the network. Unknown addresses fail like an unreachable site.
import { readFileSync } from 'node:fs';

interface Recorded {
  status: number;
  body: unknown;
  contentType?: string;
}

let cache: Record<string, Recorded> | undefined;

function recordings(): Record<string, Recorded> {
  cache ??= (JSON.parse(readFileSync(new URL('./recordings/sites.json', import.meta.url), 'utf8')) as { responses: Record<string, Recorded> }).responses;
  return cache;
}

/** Usernames with recordings: CoachVerify (Lichess), coachverify (chess.com), NoSuchPlayer and BusyPlayer. */
export function recordedFetch(overrides: Record<string, Recorded> = {}): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = `${url.origin}${url.pathname}`;
    const hit = overrides[key] ?? recordings()[key];
    if (!hit) throw new TypeError(`fetch failed: no recording for ${key}`);
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    return new Response(body, { status: hit.status, headers: { 'content-type': hit.contentType ?? 'application/json' } });
  };
}
