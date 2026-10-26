// The package check: does `npx openchesscoach` work for a friend on this system? It runs the npm
// tarball the way the welcome page (site/index.html) tells people to, with a stand-in for Claude
// Code, from a folder with a space in its name (like many Windows home folders), and checks what a
// first start needs:
//   - without Claude Code, the app stops and prints this system's install command;
//   - with Claude Code logged in, it starts, serves the web app and prints the pairing code;
//   - a device pairs with that code, and the desktop's own Engine analyses a position.
// The release workflow runs it on Windows, macOS and Linux before publishing.
//
//   npm run build && npm pack -w packages/backend && node scripts/package-smoke.ts openchesscoach-<version>.tgz
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { installFix } from '../packages/backend/src/claude-check.ts';
import { CoachClient, pairDevice } from '../packages/backend/src/client.ts';

const win = process.platform === 'win32';
const tarball = process.argv[2];
if (!tarball) {
  process.stderr.write('Usage: node scripts/package-smoke.ts <openchesscoach-x.y.z.tgz>\n');
  process.exit(2);
}
const pkg = resolve(tarball);
const work = mkdtempSync(join(tmpdir(), 'coach smoke-'));
const home = join(work, 'home');
mkdirSync(home);
const port = 18000 + Math.floor(Math.random() * 1000);
const ENGINE_TIMEOUT = 60_000;
let failed = false;

function check(ok: unknown, what: string, detail = ''): void {
  process.stdout.write(`${ok ? '✓' : '✗'} ${what}${detail ? `: ${detail}` : ''}\n`);
  if (!ok) failed = true;
}

/** A stand-in `claude` that answers `auth status --json` as a logged-in Claude Code does. */
function fakeClaude(): string {
  const dir = join(work, 'claude bin');
  mkdirSync(dir);
  const path = join(dir, win ? 'claude.cmd' : 'claude');
  writeFileSync(path, win ? '@echo {"loggedIn":true}\r\n' : '#!/bin/sh\necho \'{"loggedIn":true}\'\n');
  if (!win) chmodSync(path, 0o755);
  return path;
}

/** `npx <tarball> …`, as a friend types it (npx.cmd on Windows, as the welcome page says). */
interface Run {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function npx(args: string[], env: NodeJS.ProcessEnv): Run {
  const all = ['--yes', '--package', pkg, 'openchesscoach', ...args];
  // On Windows npx.cmd only runs through a shell: one quoted command line, as a friend types it
  // (an args array with a shell is deprecated on Node 24).
  const child = win
    ? spawn(['npx.cmd', ...all].map((a) => (/[\s&()^%]/.test(a) ? `"${a}"` : a)).join(' '), { cwd: work, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npx', all, { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.on('data', (d) => (text += String(d)));
  child.stderr?.on('data', (d) => (text += String(d)));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, output: () => text, exited };
}

function hasClaude(dir: string): boolean {
  return ['claude', 'claude.exe', 'claude.cmd'].some((name) => existsSync(join(dir, name)));
}

/** Node.js's folder, or on macOS and Linux a folder of links to just node, npm and npx, in case Claude Code sits beside them. */
function nodeOnly(nodeDir: string): string {
  if (!hasClaude(nodeDir)) return nodeDir;
  if (win) throw new Error(`Claude Code sits next to Node.js in ${nodeDir}, so this check can't hide it. Run it where Claude Code is installed elsewhere.`);
  const dir = join(work, 'node bin');
  mkdirSync(dir);
  for (const name of ['node', 'npm', 'npx']) symlinkSync(realpathSync(join(nodeDir, name)), join(dir, name));
  return dir;
}

/** Waits for the output to match, giving up early when the process has exited. */
async function waitFor(run: Run, pattern: RegExp, ms: number): Promise<RegExpMatchArray | null> {
  let exited = false;
  void run.exited.then(() => (exited = true));
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = run.output().match(pattern);
    if (m || exited) return m;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Stops npx and the app it started: the whole process tree on Windows, the process group elsewhere. */
async function stop(run: Run): Promise<void> {
  const pid = run.child.pid;
  if (!pid) return;
  if (win) spawn('taskkill', ['/pid', String(pid), '/t', '/f']);
  else {
    try {
      process.kill(-pid, 'SIGINT');
    } catch {
      // already gone
    }
  }
  await Promise.race([run.exited, new Promise((r) => setTimeout(r, 10_000))]);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms))]);
}

// A fresh npm cache, so npx installs the package as it would on a friend's desktop.
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  npm_config_cache: join(work, 'npm cache'),
  npm_config_update_notifier: 'false',
};
delete baseEnv.CHESS_COACH_CLAUDE;
// Where WinGet links Claude Code, which the app also searches: empty, like the home folder.
if (win) baseEnv.LOCALAPPDATA = join(work, 'local app data');

// 1. No Claude Code: a PATH with Node.js and the system's own folders, none of them holding
//    `claude`, and an empty home folder.
{
  const pathKey = Object.keys(baseEnv).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const nodeDir = dirname(process.execPath);
  const run = npx(['--no-open', '--port', String(port), '--data-dir', join(work, 'data none')], {
    ...baseEnv,
    [pathKey]: [nodeOnly(nodeDir), ...(baseEnv[pathKey] ?? '').split(delimiter).filter((d) => d && d !== nodeDir && !hasClaude(d))].join(delimiter),
  });
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 240_000));
  const code = await Promise.race([run.exited, timeout]);
  if (code === 'timeout') await stop(run);
  check(code === 2, 'without Claude Code the app stops with exit code 2', String(code));
  check(run.output().includes(installFix()), "and prints this system's Claude Code install command", run.output().trim().split('\n').pop());
}

// 2. Claude Code logged in: the app starts, serves the web app and pairs a device.
const run = npx(['--no-open', '--port', String(port + 1), '--data-dir', join(work, 'data')], { ...baseEnv, CHESS_COACH_CLAUDE: fakeClaude() });
try {
  const code = await waitFor(run, /Pairing code:\s+(\S+)/, 240_000);
  check(code, 'the app starts and prints a pairing code', code ? undefined : run.output().slice(-2000));
  if (code) {
    const url = `http://127.0.0.1:${port + 1}`;
    const page = await fetch(`${url}/`);
    check(page.ok && (await page.text()).includes('<div id="app"'), 'it serves the web app', String(page.status));
    const token = await pairDevice(url, code[1] as string, 'package check');
    check(token, 'a device pairs with the printed code');
    const client = await CoachClient.connect(url, token);
    const started = Date.now();
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
    const analysis = await withTimeout(client.request('engine.analyse', { fen }), ENGINE_TIMEOUT, "The desktop's Engine");
    check(analysis.lines.length > 0 && analysis.depth >= 10, "the desktop's Engine analyses a position", `depth ${analysis.depth}, ${analysis.lines.length} lines, ${Date.now() - started} ms`);
    await client.close();
  }
} catch (err) {
  check(false, 'the app answers', err instanceof Error ? err.message : String(err));
} finally {
  await stop(run);
}
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  // Windows can hold a file a moment longer; the system cleans its temp folder.
}
process.stdout.write(failed ? '\nThe package check failed.\n' : '\nThe package works on this system.\n');
process.exit(failed ? 1 : 0);
