// Protocol test helpers: a verify-mode instance per test and a client that speaks the same
// WebSocket protocol as the web app. Database readback goes straight to the instance's database.
import { afterEach } from 'vitest';
import { CoachClient } from '../src/client.ts';
import { quietSqliteWarning } from '../src/runtime.ts';
import { startVerifyInstance, type VerifyInstance, type VerifyOptions } from '../src/verify/instance.ts';

quietSqliteWarning();

const running: VerifyInstance[] = [];
const clients: CoachClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const i of running.splice(0)) await i.stop();
});

export async function instance(options: VerifyOptions = {}): Promise<VerifyInstance> {
  const i = await startVerifyInstance({ chunkDelayMs: 0, ...options });
  running.push(i);
  return i;
}

export async function client(i: VerifyInstance, token = i.token): Promise<CoachClient> {
  const c = await CoachClient.connect(i.url, token);
  clients.push(c);
  return c;
}

export function rows<T = Record<string, unknown>>(i: VerifyInstance, sql: string, ...params: (string | number)[]): T[] {
  return i.app.db.prepare(sql).all(...params) as T[];
}
