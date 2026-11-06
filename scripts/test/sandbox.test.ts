import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchModel } from '../sandbox/fetch-model.ts';

const script = new URL('../sandbox/prepare.sh', import.meta.url).pathname;
const bytes = new TextEncoder().encode('a small stand-in for the model file');
const asset = { name: 'test-model', url: 'https://models.invalid/test-model.onnx', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
const dirs: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
  dirs.push(dir);
  return dir;
}

function serving(body: Uint8Array<ArrayBuffer>) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the model download for a new machine', () => {
  it('puts the checked file under its checksum name, and a second run downloads nothing', async () => {
    const dir = folder();
    const first = serving(bytes);
    const state = await fetchModel({ dir, asset, fetch: first.fetch });
    expect(state.model).toBe('ready');
    expect(state.path).toBe(join(dir, `test-model-${asset.sha256.slice(0, 8)}.onnx`));
    expect(existsSync(state.path)).toBe(true);
    expect(first.calls).toEqual([asset.url]);

    const second = serving(new Uint8Array());
    expect((await fetchModel({ dir, asset, fetch: second.fetch })).model).toBe('ready');
    expect(second.calls).toEqual([]);
  });

  it('keeps no file that fails its checksum, and says so', async () => {
    const dir = folder();
    const wrong = new Uint8Array(bytes.byteLength).fill(120);
    const state = await fetchModel({ dir, asset, fetch: serving(wrong).fetch });
    expect(state.model).toBe('failed');
    expect(state.detail).toContain('checksum');
    expect(readdirSync(dir).filter((f) => f.endsWith('.onnx'))).toEqual([]);
  });
});

describe('prepare.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  it('refuses an option it does not know before it changes anything', () => {
    const run = spawnSync('bash', [script, '--nope'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage');
    expect(run.stdout).toBe('');
  });
});
