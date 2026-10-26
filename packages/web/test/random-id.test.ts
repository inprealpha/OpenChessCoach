// Ids the web app makes up itself, on secure origins and on a phone's http Wi-Fi address alike.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '../src/lib/random-id.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID where the browser has it', () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it('makes a version 4 UUID without crypto.randomUUID, as on a page served over plain http', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: <T extends Uint8Array<ArrayBuffer>>(a: T) => real.getRandomValues(a) });
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
