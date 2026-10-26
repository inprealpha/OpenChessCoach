// The start-up checks and verify mode itself.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { PROTOCOL_VERSION } from '@chess-coach/shared/protocol';
import { checkClaude, installDirs, installFix, isWindowsShim, LOGIN_FIX, shimTarget } from '../src/claude-check.ts';
import { minNode, nodeTooOld, startOptions } from '../src/runtime.ts';
import { client, instance } from './helpers.ts';

function fakeClaude(stdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/bin/sh\necho '${stdout}'\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === 'win32')('the Claude Code check', () => {
  it('passes when Claude Code is logged in', async () => {
    expect(await checkClaude(fakeClaude('{"loggedIn":true,"authMethod":"claude.ai"}'))).toMatchObject({ ok: true });
  });

  it('names the fix when Claude Code is logged out', async () => {
    expect(await checkClaude(fakeClaude('{"loggedIn":false}'))).toMatchObject({ ok: false, message: LOGIN_FIX });
  });

  it('names the fix when Claude Code is not installed', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-claude-'));
    withEnv({ PATH: empty, HOME: empty, CHESS_COACH_CLAUDE: undefined });
    expect(await checkClaude()).toEqual({ ok: false, message: installFix() });
  });

  it("finds Claude Code in the native installer's folder when the terminal's PATH doesn't have it yet", async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const claude = join(home, '.local', 'bin', 'claude');
    writeFileSync(claude, `#!/bin/sh\necho '{"loggedIn":true}'\n`);
    chmodSync(claude, 0o755);
    withEnv({ PATH: mkdtempSync(join(tmpdir(), 'no-claude-')), HOME: home, CHESS_COACH_CLAUDE: undefined });
    expect(await checkClaude()).toEqual({ ok: true, path: claude, message: 'Claude Code is installed and logged in.' });
  });
});

describe('the start-up messages', () => {
  it("gives each system Claude Code's own install command", () => {
    expect(installFix('darwin')).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installFix('linux')).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installFix('win32')).toContain('irm https://claude.ai/install.ps1 | iex');
  });

  it("looks in the native installer's folder and WinGet's links", () => {
    expect(installDirs('/home/p', {})).toEqual([join('/home/p', '.local', 'bin'), join('/home/p', '.claude', 'local')]);
    expect(installDirs('C:/Users/A B', { LOCALAPPDATA: 'C:/Users/A B/AppData/Local' })).toContain(
      join('C:/Users/A B/AppData/Local', 'Microsoft', 'WinGet', 'Links'),
    );
  });

  it("tells npm's Windows shims apart from real executables", () => {
    expect(isWindowsShim('C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd')).toBe(true);
    expect(isWindowsShim('C:\\Users\\A B\\.local\\bin\\claude.exe')).toBe(false);
    expect(isWindowsShim('/usr/local/bin/claude')).toBe(false);
  });

  it('names the Node.js to install when this one is too old', () => {
    expect(minNode()).toBe('22.18');
    expect(nodeTooOld('20.11.1')).toMatch(/needs Node\.js 22\.18 or later, and this terminal has Node\.js 20\.11\.1/);
    expect(nodeTooOld('22.17.0')).toBeDefined();
    expect(nodeTooOld('22.18.0')).toBeUndefined();
    expect(nodeTooOld('24.1.0')).toBeUndefined();
    expect(nodeTooOld('24.0.0', '24.0.1')).toBeDefined();
    expect(nodeTooOld('24.0.1', '24.0.1')).toBeUndefined();
  });

  it("follows npm's claude.cmd to the claude.exe it starts", () => {
    const dir = mkdtempSync(join(tmpdir(), 'npm prefix-'));
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    const shim = join(dir, 'claude.cmd');
    writeFileSync(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    expect(shimTarget(shim)).toBe(exe);
    rmSync(exe);
    expect(shimTarget(shim)).toBeUndefined();
  });
});

describe("the start command's options", () => {
  it('starts on 8737 with the browser by default, and reads every option', () => {
    expect(startOptions([])).toEqual({ do: 'start', port: 8737, host: '0.0.0.0', open: true });
    expect(startOptions(['--port', '9000', '--host=127.0.0.1', '--data-dir', '/tmp/a b', '--no-open'])).toEqual({
      do: 'start',
      port: 9000,
      host: '127.0.0.1',
      dataDir: '/tmp/a b',
      open: false,
    });
  });

  it('answers --help, -h, --version and -v instead of starting', () => {
    expect(startOptions(['--help'])).toEqual({ do: 'help' });
    expect(startOptions(['-h'])).toEqual({ do: 'help' });
    expect(startOptions(['--version'])).toEqual({ do: 'version' });
    expect(startOptions(['-v'])).toEqual({ do: 'version' });
  });

  it('refuses an option it does not know, naming it', () => {
    expect(startOptions(['--prot', '9000'])).toEqual({ do: 'error', message: 'Unknown option --prot.' });
    expect(startOptions(['-x'])).toEqual({ do: 'error', message: 'Unknown option -x.' });
    expect(startOptions(['9000'])).toEqual({ do: 'error', message: 'Unexpected argument "9000".' });
  });

  it('says when an option is missing its value', () => {
    expect(startOptions(['--port'])).toEqual({ do: 'error', message: '--port needs a value after it.' });
    expect(startOptions(['--data-dir'])).toEqual({ do: 'error', message: '--data-dir needs a value after it.' });
    expect(startOptions(['--port', '--no-open'])).toEqual({ do: 'error', message: '--port needs a value after it.' });
  });

  it('says when the port is not a port number', () => {
    const notAPort = (value: string) => `--port needs a whole number from 1 to 65535, and "${value}" isn't one.`;
    for (const value of ['abc', '0', '65536', '80.5', '-1', '']) {
      expect(startOptions(['--port', value])).toEqual({ do: 'error', message: notAPort(value) });
    }
    expect(startOptions(['--port=65535'])).toMatchObject({ do: 'start', port: 65535 });
  });
});

/** Sets environment variables for one test (undefined removes one) and restores them after it. */
function withEnv(vars: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  onTestFinished(() => apply(saved));
}

describe('verify mode', () => {
  it('runs two instances side by side without interfering', async () => {
    const a = await instance();
    const b = await instance({ seed: 'empty' });
    expect(a.url).not.toBe(b.url);
    expect(a.dataDir).not.toBe(b.dataDir);
    const ca = await client(a);
    const cb = await client(b);
    await ca.request('profile.update', { goals: ['Only in A'] });
    expect((await cb.request('profile.get', {})).goals).toEqual([]);
    expect((await ca.request('games.list', {})).games).toHaveLength(1);
    expect((await cb.request('games.list', {})).games).toHaveLength(0);
  });

  it('serves the Engine settings at a fixed depth on one thread', async () => {
    const app = await instance();
    const config = (await (await fetch(`${app.url}/api/config`)).json()) as { verify: boolean; engine: unknown };
    expect(config).toEqual({ protocol: PROTOCOL_VERSION, verify: true, engine: { depth: 10, multiPv: 5, singleThread: true } });
  });

  it('keeps the verify routes behind a device token', async () => {
    const app = await instance();
    expect((await fetch(`${app.url}/__verify/db?table=devices`)).status).toBe(401);
    const ok = await fetch(`${app.url}/__verify/db?table=devices`, { headers: { authorization: `Bearer ${app.token}` } });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${app.url}/__verify/db?table=sqlite_master`, { headers: { authorization: `Bearer ${app.token}` } });
    expect(bad.status).toBe(400);
  });

  it('moves the fake clock', async () => {
    const app = await instance();
    const res = await fetch(`${app.url}/__verify/clock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.token}` },
      body: JSON.stringify({ set: '2026-06-01T00:00:00.000Z', advanceMs: 1000 }),
    });
    expect(await res.json()).toEqual({ now: '2026-06-01T00:00:01.000Z' });
  });

  it('turns the tunnel on and off with the stand-in tunnel', async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('settings.update', { tunnelEnabled: true });
    await expect.poll(() => c.events.find((e) => e.kind === 'tunnel' && e.tunnel.status === 'running')).toBeTruthy();
    const info = await c.request('pairing.info', {});
    expect(info.tunnel).toMatchObject({ status: 'running', url: 'https://verify-mode.trycloudflare.com' });
    await c.request('settings.update', { tunnelEnabled: false });
    expect((await c.request('pairing.info', {})).tunnel.status).toBe('off');
  });

  it('keeps the tunnel setting across a restart and puts each new address in the QR code', async () => {
    let starts = 0;
    const tunnelStarter = async () => {
      starts++;
      return { url: `https://address-${starts}.trycloudflare.com`, stop: async () => {}, onExit: () => {} };
    };
    const dataDir = mkdtempSync(join(tmpdir(), 'chess-coach-tunnel-'));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = await instance({ dataDir, tunnelStarter });
    const c = await client(first);
    await c.request('settings.update', { tunnelEnabled: true });
    await expect.poll(async () => (await c.request('pairing.info', {})).tunnelPairUrl).toMatch(/^https:\/\/address-1\.trycloudflare\.com\/#pair=/);
    const firstQr = (await c.request('pairing.info', {})).tunnelQrSvg;
    await c.close();
    await first.stop({ keepData: true });

    // The setting survives a restart, the tunnel comes back by itself with a new address, and the QR code follows it.
    const second = await instance({ dataDir, tunnelStarter });
    const c2 = await client(second);
    expect((await c2.request('settings.get', {})).tunnelEnabled).toBe(true);
    await expect.poll(async () => (await c2.request('pairing.info', {})).tunnelPairUrl).toMatch(/^https:\/\/address-2\.trycloudflare\.com\/#pair=/);
    const secondQr = (await c2.request('pairing.info', {})).tunnelQrSvg;
    expect(secondQr).toMatch(/^<svg/);
    expect(secondQr).not.toBe(firstQr);
  });
});
