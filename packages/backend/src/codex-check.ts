// Finds the Codex CLI and checks local Codex credentials before starting the Coach.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CodexCheckResult =
  | { ok: true; path?: string; authSource: 'env' | 'codex-auth' }
  | { ok: false; code: 'missing-cli' | 'not-logged-in'; message: string; path?: string };

export interface CodexCheckDeps {
  findCli?: () => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

export const CODEX_LOGIN_FIX = 'Run `codex login` in a terminal to sign in with your ChatGPT subscription, or set `OPENAI_API_KEY`.';

const CODEX_INSTALL_FIX = 'Install Codex CLI (`npm install -g @openai/codex`) and run `codex login`.';

/** Looks for `codex` on PATH, or falls back to the bundled binary in `@openai/codex` if present. */
export async function findCodex(): Promise<string | undefined> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['codex'], { timeout: 5_000 });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    if (first && existsSync(first)) return first;
  } catch {
    // Not on PATH; the SDK may still resolve its own bundled @openai/codex binary.
  }
  return undefined;
}

/**
 * Checks whether `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) holds non-empty credentials.
 * Never returns or logs any token value.
 */
function hasStoredCodexAuth(deps: Required<Pick<CodexCheckDeps, 'env' | 'homeDir' | 'fileExists' | 'readFile'>>): boolean {
  const codexHome = deps.env.CODEX_HOME?.trim() || join(deps.homeDir, '.codex');
  const authPath = join(codexHome, 'auth.json');
  if (!deps.fileExists(authPath)) return false;
  try {
    const parsed = JSON.parse(deps.readFile(authPath)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return false;
    if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim().length > 0) return true;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    if (tokens && typeof tokens === 'object') {
      if (typeof tokens.access_token === 'string' && tokens.access_token.trim().length > 0) return true;
      if (typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim().length > 0) return true;
      if (typeof tokens.id_token === 'string' && tokens.id_token.trim().length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Verifies that Codex has usable local credentials (env key or `~/.codex/auth.json`).
 * Note: `@openai/codex-sdk` bundles `@openai/codex`, so a missing PATH binary is only an error
 * if neither PATH nor bundled SDK binary is available; however, missing credentials always fail
 * readiness so auto-detection never selects an unauthenticated Codex install.
 */
export async function checkCodex(deps: CodexCheckDeps = {}): Promise<CodexCheckResult> {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? homedir();
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const cliPath = deps.findCli ? await deps.findCli() : await findCodex();

  const hasEnvKey = Boolean(env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim());
  if (hasEnvKey) {
    return { ok: true, ...(cliPath ? { path: cliPath } : {}), authSource: 'env' };
  }

  if (hasStoredCodexAuth({ env, homeDir, fileExists, readFile })) {
    return { ok: true, ...(cliPath ? { path: cliPath } : {}), authSource: 'codex-auth' };
  }

  if (!cliPath) {
    return {
      ok: false,
      code: 'not-logged-in',
      message: `Codex is not logged in on the desktop. ${CODEX_LOGIN_FIX} (${CODEX_INSTALL_FIX})`,
    };
  }

  return {
    ok: false,
    code: 'not-logged-in',
    path: cliPath,
    message: `Codex is not logged in on the desktop. ${CODEX_LOGIN_FIX}`,
  };
}

/** True when a Codex error message indicates missing, expired, or rejected authentication. */
export function isCodexAuthError(message: string): boolean {
  return /\b(401|403|unauthorized|unauthenticated|invalid[_\s-]?api[_\s-]?key|not logged in|login required|token expired|authentication failed|auth(?:entication)? error|sign in)\b/i.test(
    message,
  );
}

/** True when a Codex error message indicates a ChatGPT / OpenAI rate or usage limit. */
export function isCodexLimitError(message: string): boolean {
  return /\b(429|rate[_\s-]?limit|usage[_\s-]?limit|quota exceeded|too many requests|limit reached|insufficient_quota)\b/i.test(
    message,
  );
}
