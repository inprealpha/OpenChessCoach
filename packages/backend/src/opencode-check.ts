// Finds the OpenCode CLI and checks local OpenCode availability before starting the Coach.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type OpenCodeCheckResult =
  | { ok: true; path: string; authSource: 'env' | 'opencode-auth' | 'opencode-cli' }
  | { ok: false; code: 'missing-cli'; message: string };

export interface OpenCodeCheckDeps {
  findCli?: () => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileExists?: (path: string) => boolean;
}

export const OPENCODE_LOGIN_FIX =
  'Run `opencode auth login` in a terminal to connect a provider, or select one of OpenCode’s free models in OpenCode.';

const OPENCODE_INSTALL_FIX =
  'Install OpenCode (`curl -fsSL https://opencode.ai/install | bash` or `npm install -g opencode-ai`), then run `opencode auth login` (or use OpenCode’s free models).';

const OPENCODE_ENV_KEYS = [
  'OPENCODE_API_KEY',
  'OPENCODE_ZEN_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
] as const;

/** Looks for `opencode` on PATH or common install locations. */
export async function findOpenCode(homeDir: string = homedir()): Promise<string | undefined> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['opencode'], { timeout: 5_000 });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    if (first && existsSync(first)) return first;
  } catch {
    // Fall through to well-known install directories.
  }

  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const candidates = [
    join(homeDir, '.opencode', 'bin', exe),
    join(homeDir, '.local', 'bin', exe),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function hasStoredOpenCodeState(deps: Required<Pick<OpenCodeCheckDeps, 'env' | 'homeDir' | 'fileExists'>>): boolean {
  const dataDirs = [
    deps.env.XDG_DATA_HOME?.trim() ? join(deps.env.XDG_DATA_HOME.trim(), 'opencode') : undefined,
    deps.env.APPDATA?.trim() ? join(deps.env.APPDATA.trim(), 'opencode') : undefined,
    join(deps.homeDir, '.local', 'share', 'opencode'),
  ].filter((d): d is string => Boolean(d));

  for (const dir of dataDirs) {
    if (deps.fileExists(join(dir, 'auth.json')) || deps.fileExists(join(dir, 'opencode.db'))) {
      return true;
    }
  }

  const configDirs = [
    deps.env.XDG_CONFIG_HOME?.trim() ? join(deps.env.XDG_CONFIG_HOME.trim(), 'opencode') : undefined,
    join(deps.homeDir, '.config', 'opencode'),
  ].filter((d): d is string => Boolean(d));

  for (const dir of configDirs) {
    if (deps.fileExists(join(dir, 'opencode.json')) || deps.fileExists(join(dir, 'opencode.jsonc'))) {
      return true;
    }
  }
  return false;
}

/**
 * Verifies that the local `opencode` CLI is installed. Because OpenCode ships with free Zen models
 * that work out of the box without a paid API key, having `opencode` installed is enough to make
 * OpenCode selectable; any provider auth error at runtime surfaces `OPENCODE_LOGIN_FIX`.
 */
export async function checkOpenCode(deps: OpenCodeCheckDeps = {}): Promise<OpenCodeCheckResult> {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? homedir();
  const fileExists = deps.fileExists ?? existsSync;
  const cliPath = deps.findCli ? await deps.findCli() : await findOpenCode(homeDir);

  if (!cliPath) {
    return {
      ok: false,
      code: 'missing-cli',
      message: `OpenCode is not installed on the desktop. ${OPENCODE_INSTALL_FIX}`,
    };
  }

  const hasEnvKey = OPENCODE_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
  if (hasEnvKey) {
    return { ok: true, path: cliPath, authSource: 'env' };
  }

  if (hasStoredOpenCodeState({ env, homeDir, fileExists })) {
    return { ok: true, path: cliPath, authSource: 'opencode-auth' };
  }

  return { ok: true, path: cliPath, authSource: 'opencode-cli' };
}

/** True when an OpenCode error message indicates missing, expired, or rejected authentication. */
export function isOpenCodeAuthError(message: string): boolean {
  return /\b(401|403|unauthorized|unauthenticated|invalid[_\s-]?api[_\s-]?key|no api key|missing api key|not logged in|login required|token expired|authentication failed|auth(?:entication)? error|providerautherror)\b/i.test(
    message,
  );
}

/** True when an OpenCode error message indicates a provider rate or usage limit. */
export function isOpenCodeLimitError(message: string): boolean {
  return /\b(429|rate[_\s-]?limit|usage[_\s-]?(?:limit|exceeded)|free[._\s-]?limit|freeusagelimiterror|quota (?:exceeded|exhausted)|too many requests|limit reached|insufficient_quota)\b/i.test(
    message,
  );
}
