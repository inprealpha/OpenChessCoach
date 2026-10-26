// Checks that Claude Code is installed and logged in, since the Coach runs on the owner's
// own Claude Code login (ADR 0001).
import { exec, execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export interface ClaudeCheck {
  ok: boolean;
  /** Absolute path of the `claude` executable, when found. */
  path?: string;
  /** What is wrong and how to fix it, written for the owner. */
  message: string;
}

/** The install command from Claude Code's own setup page, for this desktop's system. */
export function installFix(platform: NodeJS.Platform = process.platform): string {
  const install =
    platform === 'win32'
      ? 'in PowerShell with `irm https://claude.ai/install.ps1 | iex`'
      : 'with `curl -fsSL https://claude.ai/install.sh | bash`';
  return `Claude Code is not installed. Install it ${install}, open a new terminal, run \`claude\` once and log in, then start the app again.`;
}
export const LOGIN_FIX =
  'Claude Code is installed but not logged in. Run `claude`, type /login and sign in with your Claude account, then start the app again.';

/**
 * Where Claude Code's installers put `claude` when the terminal's PATH doesn't have it yet: the
 * native installer (~/.local/bin on every system), the older local install, and WinGet's links.
 */
export function installDirs(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [join(home, '.local', 'bin'), join(home, '.claude', 'local')];
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  return dirs;
}

export function findClaude(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env.CHESS_COACH_CLAUDE;
  if (candidate) return isExecutable(candidate) ? (isWindowsShim(candidate) ? (shimTarget(candidate) ?? candidate) : candidate) : undefined;
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...installDirs()].filter(Boolean);
  // On Windows a real claude.exe anywhere beats npm's claude.cmd, and the shim is followed to the
  // claude.exe it starts when it can be; an extensionless `claude` there is a script for another shell.
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const name of names) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (isExecutable(full)) return name === 'claude.cmd' ? (shimTarget(full) ?? full) : full;
    }
  }
  return undefined;
}

/** npm's .cmd shims start their target as "%dp0%\\…\\claude.exe"; this returns that file when it exists. */
export function shimTarget(shim: string): string | undefined {
  try {
    const m = readFileSync(shim, 'utf8').match(/"%dp0%\\([^"]+\.exe)"/i);
    const target = m ? join(dirname(shim), ...(m[1] as string).split('\\')) : undefined;
    return target && existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** npm's `claude.cmd` on Windows only starts through a shell; Node refuses to spawn it directly. */
export function isWindowsShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkClaude(explicit?: string): Promise<ClaudeCheck> {
  const path = findClaude(explicit);
  if (!path) return { ok: false, message: installFix() };
  // A .cmd shim only runs through a shell: one quoted command line, so a home folder with a space
  // in it still works (an args array with a shell is deprecated on Node 24).
  const output = await new Promise<{ stdout: string; failed: boolean }>((resolve) => {
    const done = (err: Error | null, stdout: string | Buffer) => resolve({ stdout: String(stdout ?? ''), failed: Boolean(err) && !stdout });
    if (process.platform === 'win32' && isWindowsShim(path)) exec(`"${path}" auth status --json`, { timeout: 20_000 }, done);
    else execFile(path, ['auth', 'status', '--json'], { timeout: 20_000 }, done);
  });
  if (output.failed) {
    return { ok: false, path, message: `Could not ask Claude Code whether it is logged in (\`${path} auth status\` failed). ${LOGIN_FIX}` };
  }
  try {
    const status = JSON.parse(output.stdout) as { loggedIn?: boolean };
    if (status.loggedIn) return { ok: true, path, message: 'Claude Code is installed and logged in.' };
  } catch {
    // fall through
  }
  return { ok: false, path, message: LOGIN_FIX };
}
