// Shared CI provider ordering, credential detection, and fallback classification for Verdict,
// real Coach, and the weekly provider health check (ADR 0013).
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const CI_PROVIDERS = ['codex', 'claude', 'pi', 'opencode'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

export const JUDGE_PROVIDERS = ['codex', 'claude', 'opencode'] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

/** Default Verdict judge order: Codex first, then Claude when renewed, then free OpenCode last. */
export const DEFAULT_JUDGE_ORDER: readonly JudgeProvider[] = ['codex', 'claude', 'opencode'];

/** Default real-Coach check order: Codex first, then Claude, then Pi, then free OpenCode last. */
export const DEFAULT_COACH_CHECK_ORDER: readonly CiProvider[] = ['codex', 'claude', 'pi', 'opencode'];

/**
 * Zero-Data-Retention (ZDR) free OpenCode Zen models allowed for unauthenticated CI checks.
 * Non-ZDR free models (such as `opencode/big-pickle`) are intentionally excluded so code and
 * prompts are never sent to a free model that retains data.
 */
export const ZDR_FREE_OPENCODE_MODELS = [
  'opencode/deepseek-v4.1-flash-free',
  'opencode/hy4-flash-free',
  'opencode/longcat-2.5-free',
] as const;

/**
 * Resolves the ordered list of allowed Zero-Data-Retention free OpenCode models.
 * Set `OPENCODE_ZDR_FREE_MODELS` to override the comma-separated allowlist, or `none` to disable
 * unauthenticated free OpenCode fallback entirely.
 */
export function resolveZdrFreeOpenCodeModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const trimmed = env.OPENCODE_ZDR_FREE_MODELS?.trim();
  if (!trimmed) return [...ZDR_FREE_OPENCODE_MODELS];
  if (trimmed.toLowerCase() === 'none') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(',')) {
    const model = part.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

/** True when `model` is in the active Zero-Data-Retention free OpenCode allowlist. */
export function isZdrFreeOpenCodeModel(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = model.trim();
  if (!normalized) return false;
  return resolveZdrFreeOpenCodeModels(env).includes(normalized);
}

/** Every provider secret env var that must be scrubbed from public CI artifacts before upload. */
export const ALL_PROVIDER_SECRET_ENV_VARS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_AUTH_JSON',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_ZEN_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'PI_AUTH_JSON',
] as const;

/** Parses a comma-separated provider list, deduplicating while keeping order. */
export function parseProviderOrder<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: readonly T[],
  opts: { ignoreUnsupported?: boolean } = {},
): T[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [...fallback];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(',')) {
    const name = part.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    if (!(allowed as readonly string[]).includes(name)) {
      if (opts.ignoreUnsupported && (CI_PROVIDERS as readonly string[]).includes(name)) continue;
      throw new Error(`Unknown CI provider "${name}". Expected one of: ${allowed.join(', ')}.`);
    }
    seen.add(name);
    out.push(name as T);
  }
  return out.length ? out : [...fallback];
}

/** Resolves the ordered list of providers for Verdict ('judge') or real Coach ('coach'). */
export function resolveProviderOrder(kind: 'judge', env?: NodeJS.ProcessEnv): JudgeProvider[];
export function resolveProviderOrder(kind: 'coach', env?: NodeJS.ProcessEnv): CiProvider[];
export function resolveProviderOrder(kind: 'judge' | 'coach', env: NodeJS.ProcessEnv = process.env): CiProvider[] {
  if (kind === 'judge') {
    if (env.JUDGE_PROVIDER?.trim()) {
      return parseProviderOrder(env.JUDGE_PROVIDER, JUDGE_PROVIDERS, DEFAULT_JUDGE_ORDER);
    }
    if (env.CI_PROVIDER_ORDER?.trim()) {
      return parseProviderOrder(env.CI_PROVIDER_ORDER, JUDGE_PROVIDERS, DEFAULT_JUDGE_ORDER, { ignoreUnsupported: true });
    }
    return [...DEFAULT_JUDGE_ORDER];
  }
  if (env.COACH_CHECK_PROVIDER?.trim()) {
    return parseProviderOrder(env.COACH_CHECK_PROVIDER, CI_PROVIDERS, DEFAULT_COACH_CHECK_ORDER);
  }
  if (env.CI_PROVIDER_ORDER?.trim()) {
    return parseProviderOrder(env.CI_PROVIDER_ORDER, CI_PROVIDERS, DEFAULT_COACH_CHECK_ORDER);
  }
  return [...DEFAULT_COACH_CHECK_ORDER];
}

export interface CredentialStatus {
  configured: boolean;
  source?: string;
}

function codexAuthPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homeDir, '.codex');
  return join(codexHome, 'auth.json');
}

/** Checks whether a provider has credentials configured in env vars (or local auth files). */
export function hasProviderCredentials(
  provider: CiProvider,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  fileExists: (path: string) => boolean = existsSync,
): CredentialStatus {
  if (provider === 'codex') {
    if (env.CODEX_API_KEY?.trim()) return { configured: true, source: 'CODEX_API_KEY' };
    if (env.OPENAI_API_KEY?.trim()) return { configured: true, source: 'OPENAI_API_KEY' };
    if (env.CODEX_AUTH_JSON?.trim()) return { configured: true, source: 'CODEX_AUTH_JSON' };
    if (fileExists(codexAuthPath(env, homeDir))) return { configured: true, source: 'codex-auth-file' };
    return { configured: false };
  }
  if (provider === 'claude') {
    if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { configured: true, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
    if (env.ANTHROPIC_API_KEY?.trim()) return { configured: true, source: 'ANTHROPIC_API_KEY' };
    if (!env.GITHUB_ACTIONS && fileExists(join(homeDir, '.claude'))) {
      return { configured: true, source: 'claude-desktop-login' };
    }
    return { configured: false };
  }
  if (provider === 'pi') {
    const piKeys = [
      'PI_AUTH_JSON',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'DEEPSEEK_API_KEY',
    ] as const;
    for (const key of piKeys) {
      if (env[key]?.trim()) return { configured: true, source: key };
    }
    if (fileExists(join(homeDir, '.pi', 'agent', 'auth.json'))) return { configured: true, source: 'pi-auth-file' };
    return { configured: false };
  }
  // OpenCode ships with free Zen models out of the box, so it is always available as a last-resort fallback.
  if (env.OPENCODE_API_KEY?.trim()) return { configured: true, source: 'OPENCODE_API_KEY' };
  if (env.OPENCODE_ZEN_API_KEY?.trim()) return { configured: true, source: 'OPENCODE_ZEN_API_KEY' };
  return { configured: true, source: 'opencode-free' };
}

/**
 * True when the Verdict judge is running on free OpenCode models rather than a paid Codex/Claude
 * provider or paid OpenCode key, so the status and PR comment label it clearly as a weaker judge.
 */
export function isWeakerJudge(provider: JudgeProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider !== 'opencode') return false;
  return !env.OPENCODE_API_KEY?.trim() && !env.OPENCODE_ZEN_API_KEY?.trim();
}

/**
 * Returns an env copy that forwards OPENCODE_ZEN_API_KEY as OPENCODE_API_KEY when OPENCODE_API_KEY
 * is unset, since the OpenCode CLI reads OPENCODE_API_KEY.
 */
export function withOpenCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.OPENCODE_API_KEY?.trim() && env.OPENCODE_ZEN_API_KEY?.trim()) {
    return { ...env, OPENCODE_API_KEY: env.OPENCODE_ZEN_API_KEY };
  }
  return env;
}

/** Accepts either raw JSON or base64-encoded JSON for auth.json secrets. */
export function decodeAuthJson(raw: string): string {
  const trimmed = raw.trim();
  const candidates = trimmed.startsWith('{') ? [trimmed] : [Buffer.from(trimmed, 'base64').toString('utf8').trim(), trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error('CODEX_AUTH_JSON is not valid JSON or base64-encoded JSON.');
}

export interface MaterializedCodexAuth {
  path: string;
  codexHome: string;
  restore: () => void;
}

/**
 * Writes CODEX_AUTH_JSON into an isolated temporary CODEX_HOME directory so it never overwrites
 * ~/.codex/auth.json or a user's custom $CODEX_HOME/auth.json.
 * Pass `codexHome` as `CODEX_HOME` to the spawned Codex process and call `restore()` in `finally`.
 */
export function materializeCodexAuth(
  env: NodeJS.ProcessEnv = process.env,
): MaterializedCodexAuth | undefined {
  const raw = env.CODEX_AUTH_JSON?.trim();
  if (!raw) return undefined;
  const decoded = `${decodeAuthJson(raw)}\n`;
  const tempHome = mkdtempSync(join(tmpdir(), 'occ-codex-'));
  const target = join(tempHome, 'auth.json');
  writeFileSync(target, decoded, { mode: 0o600 });
  let restored = false;
  return {
    path: target,
    codexHome: tempHome,
    restore: () => {
      if (restored) return;
      restored = true;
      rmSync(tempHome, { recursive: true, force: true });
    },
  };
}

export type ProviderFailureKind = 'auth' | 'quota' | 'missing-cli' | 'other';

const AUTH_ERROR_RE =
  /\b(401|403|unauthorized|unauthenticated|invalid[_\s-]?api[_\s-]?key|authentication[_\s-]?error|authentication failed|auth(?:entication)? error|not logged in|login required|token expired|expired token|oauth.*(?:expired|invalid|revoked)|refresh[_\s-]?token.*(?:expired|invalid|revoked)|providerautherror|no api key|missing api key|invalid x-api-key|please run.*login)\b/i;

const QUOTA_ERROR_RE =
  /\b(429|529|rate[_\s-]?limit|usage[_\s-]?limit|quota[_\s-]?(?:exceeded|exhausted)|too many requests|limit reached|insufficient[_\s_]?quota|credit balance is too low|billing|spending limit|free[._\s-]?limit|freeusagelimiterror|overloaded[_\s-]?error|exceeded your current quota|plan.*expired|subscription.*(?:expired|ended|inactive))\b/i;

const MISSING_CLI_RE = /\b(enoent|command not found|not installed|executable not found|spawn .* enoent)\b/i;

/** Classifies a provider error message for fallback and weekly health-check reporting. */
export function classifyProviderFailure(output: string): ProviderFailureKind {
  if (MISSING_CLI_RE.test(output)) return 'missing-cli';
  if (AUTH_ERROR_RE.test(output)) return 'auth';
  if (QUOTA_ERROR_RE.test(output)) return 'quota';
  return 'other';
}

/**
 * True when a failure comes from provider availability (missing CLI, expired/invalid login,
 * billing, quota, or rate limit) rather than a real product or Coach defect.
 */
export function isRetryableProviderFailure(output: string): boolean {
  return classifyProviderFailure(output) !== 'other';
}

/**
 * Deletes any file under `dir` that contains any non-empty configured provider secret value
 * (including decoded CODEX_AUTH_JSON tokens). Returns the deleted file paths.
 */
export function scrubSecretsFromDir(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(dir)) return [];
  const needles = new Set<string>();
  for (const name of ALL_PROVIDER_SECRET_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) needles.add(value);
  }
  if (env.CODEX_AUTH_JSON?.trim()) {
    try {
      const parsed = JSON.parse(decodeAuthJson(env.CODEX_AUTH_JSON)) as Record<string, unknown>;
      for (const value of extractSecretStrings(parsed)) {
        if (value.length >= 12) needles.add(value);
      }
    } catch {
      // raw CODEX_AUTH_JSON is already in needles
    }
  }
  if (needles.size === 0) return [];

  const removed: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        // Never follow symlinks out of the evidence directory; unlink only the symlink itself.
        rmSync(full, { force: true });
        removed.push(full);
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > 20 * 1024 * 1024) {
        rmSync(full, { force: true });
        removed.push(full);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        rmSync(full, { force: true });
        removed.push(full);
        continue;
      }
      for (const needle of needles) {
        if (text.includes(needle)) {
          rmSync(full, { force: true });
          removed.push(full);
          break;
        }
      }
    }
  };
  walk(dir);
  return removed;
}

function extractSecretStrings(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && /(token|key|secret)/i.test(key)) {
      out.push(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...extractSecretStrings(value as Record<string, unknown>));
    }
  }
  return out;
}
