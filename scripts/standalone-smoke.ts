// The standalone consumer-OS check: installs the standalone bundle with this system's native
// installer into a folder with a space in its name, then runs `openchesscoach` with NO system
// Node.js, npm, or npx on PATH. Checks:
//   - --version and --help work (and --help shows `Usage: openchesscoach [options]`);
//   - without Claude Code, the app stops with exit code 2 and prints this system's install command;
//   - with Claude Code logged in, it starts, serves the web app, prints a pairing code, pairs a
//     device, and analyses a position with the desktop's Engine;
//   - uninstall removes the app folder while leaving the user's data folder intact.
//
//   node scripts/build-standalone.ts --target current
//   node scripts/standalone-smoke.ts dist-standalone/openchesscoach-<target>.<ext>
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { installFix } from '../packages/backend/src/claude-check.ts';
import { CoachClient, pairDevice } from '../packages/backend/src/client.ts';

const win = process.platform === 'win32';
const testWinSystem = win && Boolean(process.env.CI);
const archiveArg = process.argv[2];
if (!archiveArg) {
  process.stderr.write('Usage: node scripts/standalone-smoke.ts <openchesscoach-target.(zip|tar.gz)>\n');
  process.exit(2);
}
const archive = resolve(archiveArg);
const repo = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'coach standalone-'));
const home = join(work, 'home');
const installDir = join(work, "install O'Brien");
const binDir = join(work, 'bin dir');
const dataDir = join(work, 'data dir');
mkdirSync(home, { recursive: true });
const port = 19000 + Math.floor(Math.random() * 1000);
const ENGINE_TIMEOUT = 60_000;
let failed = false;

function getUserPath(): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"], {
    encoding: 'utf8',
  }).trim();
}

function setUserPath(value: string): void {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::SetEnvironmentVariable('Path', $env:OCC_TEST_PATH, 'User')"], {
    env: { ...process.env, OCC_TEST_PATH: value },
    stdio: 'pipe',
  });
}

function readStartMenuShortcut(): { exists: boolean; path: string; target?: string; args?: string } {
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "$p = Join-Path ([Environment]::GetFolderPath('Programs')) 'OpenChessCoach.lnk'; " +
        "if (Test-Path $p) { $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($p); " +
        '@{ exists = $true; path = $p; target = $sc.TargetPath; args = $sc.Arguments } | ConvertTo-Json -Compress } ' +
        'else { @{ exists = $false; path = $p } | ConvertTo-Json -Compress }',
    ],
    { encoding: 'utf8' },
  ).trim();
  return JSON.parse(raw) as { exists: boolean; path: string; target?: string; args?: string };
}

function check(ok: unknown, what: string, detail = ''): void {
  process.stdout.write(`${ok ? '✓' : '✗'} ${what}${detail ? `: ${detail}` : ''}\n`);
  if (!ok) failed = true;
}

function hasAny(dir: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(dir, name)));
}

/** A PATH containing OS essentials (and our installed binDir) with NO system node/npm/npx and NO claude. */
function cleanPath(basePath: string | undefined, extraDirs: string[]): string {
  const blocked = ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'claude', 'claude.exe', 'claude.cmd'];
  const kept = (basePath ?? '').split(delimiter).filter((d) => d && !hasAny(d, blocked));
  return [...extraDirs, ...kept].join(delimiter);
}

function fakeClaude(): string {
  const dir = join(work, 'claude bin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, win ? 'claude.cmd' : 'claude');
  writeFileSync(path, win ? '@echo {"loggedIn":true}\r\n' : '#!/bin/sh\necho \'{"loggedIn":true}\'\n');
  if (!win) chmodSync(path, 0o755);
  return path;
}

interface Run {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function runInstalled(launcher: string, args: string[], env: NodeJS.ProcessEnv): Run {
  const child = win
    ? spawn([launcher, ...args].map((a) => (/[\s&()^%]/.test(a) ? `"${a}"` : a)).join(' '), {
        cwd: work,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(launcher, args, { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.on('data', (d) => (text += String(d)));
  child.stderr?.on('data', (d) => (text += String(d)));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, output: () => text, exited };
}

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

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const savedUserPath = testWinSystem ? getUserPath() : null;
const seedUserPathEntry = join(work, 'existing bin');

try {
  // 1. Install using this platform's native installer.
  try {
    if (win) {
      if (testWinSystem) setUserPath(seedUserPathEntry);
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts', 'install.ps1'), '-Archive', archive, '-InstallDir', installDir];
      if (!testWinSystem) args.push('-NoPath', '-NoShortcut');
      execFileSync('powershell.exe', args, { env: process.env, stdio: 'pipe' });
    } else {
      execFileSync('bash', [join(repo, 'scripts', 'install.sh'), '--archive', archive, '--install-dir', installDir, '--bin-dir', binDir], {
        env: { ...process.env, HOME: home },
        stdio: 'pipe',
      });
    }
  } catch (err) {
    check(false, 'native installer succeeds', err instanceof Error ? err.message : String(err));
  }

  const launcher = win ? join(installDir, 'openchesscoach.cmd') : join(binDir, 'openchesscoach');
  check(existsSync(launcher), 'launcher exists after install', launcher);

  let persistedUserPathEntries: string[] = [];
  if (testWinSystem) {
    persistedUserPathEntries = getUserPath()
      .split(';')
      .filter(Boolean);
    const norm = (p: string) => p.replace(/\\+$/, '').toLowerCase();
    check(
      persistedUserPathEntries.some((p) => norm(p) === norm(seedUserPathEntry)) &&
        persistedUserPathEntries.some((p) => norm(p) === norm(installDir)),
      'single-entry user PATH keeps existing entry and adds installDir',
      persistedUserPathEntries.join(';'),
    );
  }

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    [pathKey]: cleanPath(process.env[pathKey], testWinSystem ? persistedUserPathEntries : [win ? installDir : binDir]),
  };
  delete baseEnv.CHESS_COACH_CLAUDE;
  delete baseEnv.CHESS_COACH_SKIP_LOGIN_CHECK;
  if (win) {
    baseEnv.LOCALAPPDATA = join(work, 'local app data');
    baseEnv.APPDATA = join(work, 'roaming app data');
  }

  // 2. --help works via PATH command discovery with NO system node/npm on PATH.
  {
    const helpRun = runInstalled('openchesscoach', ['--help'], baseEnv);
    const code = await Promise.race([helpRun.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
    if (code === 'timeout') await stop(helpRun);
    check(
      code === 0 && helpRun.output().includes('Usage: openchesscoach [options]'),
      'openchesscoach --help resolves on PATH without system Node and prints standalone usage',
      String(code),
    );
  }

  if (testWinSystem) {
    const sc = readStartMenuShortcut();
    check(sc.exists && Boolean(sc.target) && Boolean(sc.args), 'Start Menu shortcut exists after install', sc.path);
    if (sc.exists && sc.target && sc.args) {
      const cmdLine = `"${sc.target}" ${sc.args.replace("openchesscoach.cmd'", "openchesscoach.cmd' --help")}`;
      const child = spawn(cmdLine, { cwd: work, env: baseEnv, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: string[] = [];
      child.stdout?.on('data', (b) => chunks.push(String(b)));
      child.stderr?.on('data', (b) => chunks.push(String(b)));
      const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
      const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
      if (code === 'timeout') await stop({ child, output: () => chunks.join(''), exited });
      const out = chunks.join('');
      check(
        code === 0 && out.includes('Usage: openchesscoach [options]'),
        'Start Menu shortcut launches install path with spaces and apostrophe',
        code === 0 ? undefined : `${String(code)}: ${out.slice(-500)}`,
      );
    }
  }

  // 3. Without Claude Code, stops with exit code 2 and prints this system's install command.
  {
    const run = runInstalled('openchesscoach', ['--no-open', '--port', String(port), '--data-dir', join(work, 'data none')], baseEnv);
    const code = await Promise.race([run.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 60_000))]);
    if (code === 'timeout') await stop(run);
    check(code === 2, 'without Claude Code the standalone app stops with exit code 2', String(code));
    check(run.output().includes(installFix()), "and prints this system's Claude Code install command", run.output().trim().split('\n').pop());
  }

  // 4. With Claude Code logged in, starts without system Node, serves web app, pairs, and runs Engine.
  const run = runInstalled('openchesscoach', ['--no-open', '--port', String(port + 1), '--data-dir', dataDir], {
    ...baseEnv,
    CHESS_COACH_CLAUDE: fakeClaude(),
    CHESS_COACH_SKIP_LOGIN_CHECK: '1',
  });
  try {
    const code = await waitFor(run, /Pairing code:\s+(\S+)/, 120_000);
    check(code, 'the standalone app starts without system Node and prints a pairing code', code ? undefined : run.output().slice(-2000));
    if (code) {
      const url = `http://127.0.0.1:${port + 1}`;
      const page = await fetch(`${url}/`);
      check(page.ok && (await page.text()).includes('<div id="app"'), 'it serves the web app', String(page.status));
      const token = await pairDevice(url, code[1] as string, 'standalone check');
      check(token, 'a device pairs with the printed code');
      const client = await CoachClient.connect(url, token);
      const started = Date.now();
      const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
      const analysis = await withTimeout(client.request('engine.analyse', { fen }), ENGINE_TIMEOUT, "The desktop's Engine");
      check(
        analysis.lines.length > 0 && analysis.depth >= 10,
        "the desktop's Engine analyses a position",
        `depth ${analysis.depth}, ${analysis.lines.length} lines, ${Date.now() - started} ms`,
      );
      await client.close();
    }
  } catch (err) {
    check(false, 'the standalone app answers', err instanceof Error ? err.message : String(err));
  } finally {
    await stop(run);
  }

  // 5. Uninstall removes the app folder while leaving the user's data folder intact.
  try {
    if (win) {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts', 'install.ps1'), '-Uninstall', '-InstallDir', installDir];
      if (!testWinSystem) args.push('-NoPath', '-NoShortcut');
      execFileSync('powershell.exe', args, { env: process.env, stdio: 'pipe' });
    } else {
      execFileSync('bash', [join(repo, 'scripts', 'install.sh'), '--uninstall', '--install-dir', installDir, '--bin-dir', binDir], {
        env: { ...process.env, HOME: home },
        stdio: 'pipe',
      });
    }
    check(!existsSync(installDir), 'uninstall removes the app directory');
    check(existsSync(dataDir), 'uninstall keeps user data intact');
    if (testWinSystem) {
      check(!readStartMenuShortcut().exists, 'uninstall removes the Start Menu shortcut');
      const afterPath = getUserPath()
        .split(';')
        .filter(Boolean);
      const norm = (p: string) => p.replace(/\\+$/, '').toLowerCase();
      check(
        afterPath.some((p) => norm(p) === norm(seedUserPathEntry)) && !afterPath.some((p) => norm(p) === norm(installDir)),
        'uninstall removes installDir from user PATH while keeping existing entry',
        afterPath.join(';'),
      );
    }
  } catch (err) {
    check(false, 'uninstall succeeds', err instanceof Error ? err.message : String(err));
  }
} finally {
  if (savedUserPath !== null) {
    try {
      setUserPath(savedUserPath);
    } catch {
      // Best-effort restore on CI runner.
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows can hold a file a moment longer; the system cleans its temp folder.
  }
}
process.stdout.write(failed ? '\nThe standalone check failed.\n' : '\nThe standalone bundle works without system Node.js.\n');
process.exit(failed ? 1 : 0);
