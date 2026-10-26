// Verify-mode-only HTTP routes: script the fake Coach, move the fake clock, read tables back.
// They exist only when the app runs in verify mode and still need a device token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FakeClock } from '../clock.ts';
import { FakeCoach, type ScriptedReply } from '../coach/fake.ts';
import { READABLE_TABLES } from '../db.ts';
import type { AppContext } from '../handlers/index.ts';
import { json, readJson } from '../server.ts';

export async function verifyRoutes(app: AppContext, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (url.pathname === '/__verify/coach/script' && req.method === 'POST') {
    const coach = app.coach.coach;
    if (!(coach instanceof FakeCoach)) return json(res, 409, { error: 'Only the fake Coach can be scripted.' });
    const body = (await readJson(req)) as ScriptedReply | { kind: 'clear' };
    if (body.kind === 'clear') coach.clearScript();
    else coach.script(body);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__verify/clock' && req.method === 'POST') {
    if (!(app.clock instanceof FakeClock)) return json(res, 409, { error: 'This instance runs on the system clock.' });
    const body = (await readJson(req)) as { set?: string; advanceMs?: number };
    if (body.set) app.clock.set(body.set);
    if (body.advanceMs) app.clock.advance(body.advanceMs);
    return json(res, 200, { now: app.clock.now().toISOString() });
  }
  if (url.pathname === '/__verify/coach/status' && req.method === 'POST') {
    const body = (await readJson(req)) as { unavailable?: string | null };
    app.coach.setUnavailable(body.unavailable ?? undefined);
    const status = await app.coach.status();
    app.broadcast({ kind: 'coach-status', status });
    return json(res, 200, status);
  }
  if (url.pathname === '/__verify/db' && req.method === 'GET') {
    const table = url.searchParams.get('table') ?? '';
    if (!(READABLE_TABLES as readonly string[]).includes(table)) {
      return json(res, 400, { error: `Unknown table. Use one of: ${READABLE_TABLES.join(', ')}` });
    }
    const rows = app.db.prepare(`SELECT * FROM ${table}`).all();
    return json(res, 200, { table, rows });
  }
  return json(res, 404, { error: 'Unknown verify route.' });
}
