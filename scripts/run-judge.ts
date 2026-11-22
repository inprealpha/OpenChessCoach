// Runs the independent Verdict judge across configured CI providers in priority order (ADR 0013).
// Tries Codex first, then Claude, then free OpenCode by default (configurable via CI_PROVIDER_ORDER
// or JUDGE_PROVIDER). Falls back only when credentials are missing or a provider hits an auth,
// billing, quota, timeout, or missing-CLI error — never after a valid FAIL verdict.
//
//   node scripts/run-judge.ts --prompt-file <file> --out <dir> [--workdir <dir>] [--max-budget-usd <n>]
//   node scripts/run-judge.ts --scrub <dir>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyProviderFailure,
  hasProviderCredentials,
  isRetryableProviderFailure,
  isWeakerJudge,
  isZdrFreeOpenCodeModel,
  type JudgeProvider,
  materializeCodexAuth,
  type ProviderFailureKind,
  resolveProviderOrder,
  resolveZdrFreeOpenCodeModels,
  scrubSecretsFromDir,
  withOpenCodeEnv,
} from './ci-providers.ts';
import { parseVerdict } from './verdict.ts';

export interface JudgeAttempt {
  provider: JudgeProvider;
  model?: string;
  outcome: 'verdict' | 'skipped' | 'provider-error' | 'no-verdict';
  reason?: string;
  failureKind?: ProviderFailureKind;
  exitCode?: number | null;
}

export interface JudgeMeta {
  provider: JudgeProvider | null;
  weakerJudge: boolean;
  source: 'ci' | 'local';
  judgeAgent?: string;
  model?: string;
  allProvidersFailed?: boolean;
  attempts: JudgeAttempt[];
}

export interface JudgeInvocation {
  provider: JudgeProvider;
  command: string;
  args: string[];
  stdin?: string;
  model?: string;
  logFile: string;
}

export type JudgeTimeoutKind = 'first-activity' | 'idle' | 'overall';

export interface JudgeExecTimeouts {
  /** Max time to wait for the first non-banner model output on streaming CLIs (ms). */
  firstActivityMs?: number;
  /** Max time to wait with zero output after activity has started (ms). */
  idleMs?: number;
  /** Max wall-clock time for a single provider/model attempt (ms). */
  overallMs?: number;
  /** Grace period after a fatal stream/provider error line before killing a hung process (ms). */
  fatalErrorGraceMs?: number;
  /** Grace period between SIGTERM and SIGKILL when terminating a hung child process (ms). */
  killGraceMs?: number;
}

export interface JudgeExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: JudgeTimeoutKind;
  abortedProviderError?: string;
}

export const DEFAULT_FIRST_ACTIVITY_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_FATAL_ERROR_GRACE_MS = 5_000;
export const DEFAULT_FREE_ATTEMPT_TIMEOUT_MS = 1_200_000;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_700_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 2_700_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const OPENCODE_BANNER_RE = /^>\s+\S+\s+·\s+\S+/;
const OPENCODE_LOG_LINE_RE = /^timestamp=\S+\s+level=(?:DEBUG|INFO|WARN|ERROR)\b/;
const MODEL_UNAVAILABLE_RE = /model.*not found|unknown model|not available|not supported/i;
const FATAL_STREAM_ERROR_FRAMING_RE =
  /^(?:timestamp=\S+\s+level=ERROR\b.*message="stream error"|(?:AI_APICallError|FreeUsageLimitError|Error):\s*.*(?:Free usage limit reached|429|401|402|403|rate limit|quota|unauthorized|authentication|model.*not found|unknown model|not available|not supported))/i;

/** Strips ANSI color codes from a single line of CLI output. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/**
 * True for OpenCode's startup banner (`> build · <model>`) and structured runtime log lines
 * (`timestamp=... level=...`), which appear before the model actually produces any answer.
 */
export function isOpenCodeStartupOrLogLine(rawLine: string): boolean {
  const clean = stripAnsi(rawLine).trim();
  if (!clean) return true;
  if (OPENCODE_BANNER_RE.test(clean)) return true;
  if (OPENCODE_LOG_LINE_RE.test(clean)) return true;
  return false;
}

/**
 * Returns the cleaned error line when an OpenCode log/output line reports a fatal provider stream
 * error (such as `AI_APICallError: Free usage limit reached`), where `opencode run 1.19.6` is
 * known to stay alive indefinitely instead of exiting.
 */
export function detectFatalProviderErrorLine(rawLine: string): string | undefined {
  const clean = stripAnsi(rawLine).trim();
  if (!clean) return undefined;
  if (!FATAL_STREAM_ERROR_FRAMING_RE.test(clean)) return undefined;
  if (isRetryableProviderFailure(clean) || MODEL_UNAVAILABLE_RE.test(clean)) {
    const extracted = /\berror(?:\.error)?="([^"]+)"/.exec(clean)?.[1];
    return extracted && (isRetryableProviderFailure(extracted) || MODEL_UNAVAILABLE_RE.test(extracted))
      ? extracted
      : clean;
  }
  return undefined;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return 'its time limit';
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const mins = ms / 60_000;
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  }
  if (ms >= 1000) {
    const secs = Math.round(ms / 1000);
    return `${secs}s`;
  }
  return `${ms}ms`;
}

/** Builds the CLI command and arguments for one judge provider. */
export function buildJudgeInvocation(
  provider: JudgeProvider,
  prompt: string,
  outDir: string,
  env: NodeJS.ProcessEnv = process.env,
  maxBudgetUsd = '5',
): JudgeInvocation {
  if (provider === 'codex') {
    const model = env.CODEX_JUDGE_MODEL?.trim() || undefined;
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
    args.push('-');
    return { provider, command: 'codex', args, stdin: prompt, ...(model ? { model } : {}), logFile: join(outDir, 'judge-codex.log') };
  }
  if (provider === 'claude') {
    const model = env.CLAUDE_JUDGE_MODEL?.trim() || env.JUDGE_MODEL?.trim() || 'opus';
    return {
      provider,
      command: 'claude',
      args: ['-p', prompt, '--model', model, '--max-budget-usd', maxBudgetUsd, '--dangerously-skip-permissions', '--output-format', 'json'],
      model,
      logFile: join(outDir, 'claude.json'),
    };
  }
  const explicitModel = env.OPENCODE_JUDGE_MODEL?.trim() || undefined;
  const model = explicitModel ?? (isWeakerJudge('opencode', env) ? resolveZdrFreeOpenCodeModels(env)[0] : undefined);
  // `--print-logs --log-level ERROR` surfaces OpenCode stream errors (like `Free usage limit
  // reached`) immediately on stderr instead of hanging silently until the step timeout.
  const args = ['run', '--print-logs', '--log-level', 'ERROR'];
  if (model) args.push('-m', model);
  args.push(prompt);
  return { provider, command: 'opencode', args, ...(model ? { model } : {}), logFile: join(outDir, 'judge-opencode.log') };
}

export interface RunJudgeDeps {
  env?: NodeJS.ProcessEnv;
  exec?: (
    inv: JudgeInvocation,
    workdir: string,
    env: NodeJS.ProcessEnv,
    timeouts?: JudgeExecTimeouts,
  ) => JudgeExecResult | Promise<JudgeExecResult>;
  hasCredentials?: (provider: JudgeProvider, env: NodeJS.ProcessEnv) => { configured: boolean; source?: string };
  materializeCodex?: (env: NodeJS.ProcessEnv) => { path: string; codexHome?: string; restore: () => void } | string | undefined;
  log?: (line: string) => void;
}

function terminateChildTree(pid: number | undefined, signal: NodeJS.Signals, fallbackKill: (sig: NodeJS.Signals) => void): void {
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process group may already have exited; fall through to direct kill.
    }
  }
  try {
    fallbackKill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Spawns a judge CLI asynchronously with process-group cleanup, fatal-error detection (so a hung
 * `opencode run` after `Free usage limit reached` is terminated within seconds), first-activity
 * timeout, idle timeout, and an overall wall-clock cap.
 */
export function execJudgeProcess(
  inv: JudgeInvocation,
  workdir: string,
  env: NodeJS.ProcessEnv,
  timeouts: JudgeExecTimeouts = {},
): Promise<JudgeExecResult> {
  return new Promise((resolveResult) => {
    const child = spawn(inv.command, inv.args, {
      cwd: workdir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stdoutPendingLine = '';
    let stderrPendingLine = '';
    let hasActivity = false;
    let settled = false;
    let timedOut: JudgeTimeoutKind | undefined;
    let abortedProviderError: string | undefined;
    let aborting = false;

    let firstActivityTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let overallTimer: NodeJS.Timeout | undefined;
    let fatalErrorTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearAllTimers = (): void => {
      if (firstActivityTimer) clearTimeout(firstActivityTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (overallTimer) clearTimeout(overallTimer);
      if (fatalErrorTimer) clearTimeout(fatalErrorTimer);
      if (killTimer) clearTimeout(killTimer);
      firstActivityTimer = undefined;
      idleTimer = undefined;
      overallTimer = undefined;
      fatalErrorTimer = undefined;
      killTimer = undefined;
    };

    const finish = (result: JudgeExecResult): void => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      resolveResult(result);
    };

    const abortProcess = (): void => {
      if (aborting || settled) return;
      aborting = true;
      terminateChildTree(child.pid, 'SIGTERM', (sig) => child.kill(sig));
      const killGraceMs = timeouts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      killTimer = setTimeout(() => {
        terminateChildTree(child.pid, 'SIGKILL', (sig) => child.kill(sig));
      }, killGraceMs);
      killTimer.unref();
    };

    const resetIdleTimer = (): void => {
      if (!timeouts.idleMs || aborting || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || aborting) return;
        timedOut = 'idle';
        abortProcess();
      }, timeouts.idleMs);
      idleTimer.unref();
    };

    const recordActivity = (): void => {
      if (!hasActivity) {
        hasActivity = true;
        if (firstActivityTimer) {
          clearTimeout(firstActivityTimer);
          firstActivityTimer = undefined;
        }
      }
      resetIdleTimer();
    };

    const inspectLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      if (inv.provider === 'opencode') {
        if (stream === 'stderr') {
          const fatal = detectFatalProviderErrorLine(line);
          if (fatal && !abortedProviderError) {
            abortedProviderError = fatal;
            const graceMs = timeouts.fatalErrorGraceMs ?? DEFAULT_FATAL_ERROR_GRACE_MS;
            fatalErrorTimer = setTimeout(() => {
              if (settled || aborting) return;
              abortProcess();
            }, graceMs);
            fatalErrorTimer.unref();
            return;
          }
        }
        if (!isOpenCodeStartupOrLogLine(line)) {
          recordActivity();
        }
        return;
      }
      if (stripAnsi(line).trim()) {
        recordActivity();
      }
    };

    const appendChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') {
        if (stdout.length < MAX_BUFFER_BYTES) {
          stdout += text.slice(0, MAX_BUFFER_BYTES - stdout.length);
        }
        const combined = stdoutPendingLine + text;
        const lines = combined.split(/\r?\n/);
        stdoutPendingLine = lines.pop() ?? '';
        for (const line of lines) inspectLine(line, 'stdout');
        // Handle non-newline-terminated model output as activity when it isn't a startup banner.
        if (stdoutPendingLine && inv.provider !== 'opencode' && stripAnsi(stdoutPendingLine).trim()) {
          recordActivity();
        }
      } else {
        if (stderr.length < MAX_BUFFER_BYTES) {
          stderr += text.slice(0, MAX_BUFFER_BYTES - stderr.length);
        }
        const combined = stderrPendingLine + text;
        const lines = combined.split(/\r?\n/);
        stderrPendingLine = lines.pop() ?? '';
        for (const line of lines) inspectLine(line, 'stderr');
      }
    };

    if (timeouts.firstActivityMs) {
      firstActivityTimer = setTimeout(() => {
        if (settled || aborting || hasActivity) return;
        timedOut = 'first-activity';
        abortProcess();
      }, timeouts.firstActivityMs);
      firstActivityTimer.unref();
    }

    if (timeouts.overallMs) {
      overallTimer = setTimeout(() => {
        if (settled || aborting) return;
        timedOut = 'overall';
        abortProcess();
      }, timeouts.overallMs);
      overallTimer.unref();
    }

    child.stdout.on('data', (chunk: Buffer) => appendChunk('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => appendChunk('stderr', chunk));

    child.on('error', (err) => {
      finish({ status: null, stdout, stderr, error: err });
    });

    child.on('close', (code) => {
      if (stdoutPendingLine) inspectLine(stdoutPendingLine, 'stdout');
      if (stderrPendingLine) inspectLine(stderrPendingLine, 'stderr');
      finish({
        status: code,
        stdout,
        stderr,
        ...(timedOut ? { timedOut } : {}),
        ...(abortedProviderError ? { abortedProviderError } : {}),
      });
    });

    child.stdin.on('error', () => {
      // Child may exit before consuming stdin (e.g., ENOENT or immediate auth failure).
    });
    if (inv.stdin) {
      child.stdin.end(inv.stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function buildTimeoutsForAttempt(
  provider: JudgeProvider,
  isFreeOpenCode: boolean,
  env: NodeJS.ProcessEnv,
  remainingTotalMs: number,
): JudgeExecTimeouts {
  const defaultOverall = isFreeOpenCode
    ? parsePositiveMs(env.JUDGE_FREE_ATTEMPT_TIMEOUT_MS, DEFAULT_FREE_ATTEMPT_TIMEOUT_MS)
    : parsePositiveMs(env.JUDGE_ATTEMPT_TIMEOUT_MS, DEFAULT_ATTEMPT_TIMEOUT_MS);
  const overallMs = Math.max(1, Math.min(defaultOverall, remainingTotalMs));

  // `claude --output-format json` buffers its entire JSON payload until completion, so it only
  // uses the overall wall-clock timeout. Streaming CLIs (`opencode`, `codex`) also get
  // first-activity, idle, and fatal-error hang watchdogs.
  if (provider === 'claude') {
    return { overallMs };
  }

  const firstActivityMs = Math.min(
    parsePositiveMs(env.JUDGE_FIRST_ACTIVITY_TIMEOUT_MS, DEFAULT_FIRST_ACTIVITY_TIMEOUT_MS),
    overallMs,
  );
  const idleMs = Math.min(parsePositiveMs(env.JUDGE_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS), overallMs);
  const fatalErrorGraceMs = parsePositiveMs(env.JUDGE_FATAL_ERROR_GRACE_MS, DEFAULT_FATAL_ERROR_GRACE_MS);
  return { firstActivityMs, idleMs, overallMs, fatalErrorGraceMs };
}

/**
 * Builds the narrowest OPENCODE_PERMISSION JSON needed for headless `opencode run` judging:
 * denies all external directories by default and allows only the judge's own input/output/base
 * directories (never a blanket `*` allow, and preserving OpenCode's default `.env` protection).
 */
export function buildOpenCodeJudgePermission(allowedDirs: readonly string[]): string {
  const externalDirectory: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  for (const dir of allowedDirs) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const normalized = resolve(trimmed).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) continue;
    externalDirectory[normalized] = 'allow';
    externalDirectory[`${normalized}/*`] = 'allow';
  }
  return JSON.stringify({
    external_directory: externalDirectory,
  });
}

/** Runs configured judge providers in order until one writes a valid verdict.json or all fail. */
export async function runJudge(
  opts: { prompt: string; outDir: string; workdir: string; maxBudgetUsd?: string; inDir?: string; baseDir?: string },
  deps: RunJudgeDeps = {},
): Promise<{ meta: JudgeMeta; hasVerdict: boolean }> {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? execJudgeProcess;
  const checkCreds = deps.hasCredentials ?? ((p, e) => hasProviderCredentials(p, e));
  const prepareCodex = deps.materializeCodex ?? ((e) => materializeCodexAuth(e));
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  mkdirSync(opts.outDir, { recursive: true });
  const order = resolveProviderOrder('judge', env);
  const attempts: JudgeAttempt[] = [];
  const verdictPath = join(opts.outDir, 'verdict.json');
  const reportPath = join(opts.outDir, 'verdict.md');
  const totalBudgetMs = parsePositiveMs(env.JUDGE_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS);
  const deadline = Date.now() + totalBudgetMs;

  outer: for (const provider of order) {
    const creds = checkCreds(provider, env);
    if (!creds.configured) {
      attempts.push({ provider, outcome: 'skipped', reason: 'no credentials configured' });
      continue;
    }

    let codexAuth: { path: string; codexHome?: string; restore: () => void } | string | undefined;
    if (provider === 'codex') {
      try {
        codexAuth = prepareCodex(env);
      } catch (err) {
        attempts.push({
          provider,
          outcome: 'provider-error',
          failureKind: 'auth',
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    rmSync(verdictPath, { force: true });
    rmSync(reportPath, { force: true });

    let runEnv: NodeJS.ProcessEnv =
      codexAuth && typeof codexAuth === 'object' && codexAuth.codexHome
        ? { ...env, CODEX_HOME: codexAuth.codexHome }
        : env;
    if (provider === 'opencode') {
      runEnv = withOpenCodeEnv(runEnv);
      if (!runEnv.OPENCODE_PERMISSION?.trim()) {
        const allowedDirs = [opts.outDir];
        if (opts.inDir) allowedDirs.push(opts.inDir);
        else if (runEnv.IN?.trim()) allowedDirs.push(runEnv.IN.trim());
        if (opts.baseDir) {
          allowedDirs.push(opts.baseDir);
        } else if (runEnv.GITHUB_WORKSPACE?.trim()) {
          const candidateBase = join(runEnv.GITHUB_WORKSPACE.trim(), 'base');
          if (existsSync(candidateBase)) allowedDirs.push(candidateBase);
        }
        runEnv = { ...runEnv, OPENCODE_PERMISSION: buildOpenCodeJudgePermission(allowedDirs) };
      }
    }

    // Free OpenCode is restricted to the Zero-Data-Retention (ZDR) model allowlist so code and
    // prompts never fall back to non-ZDR free models such as `opencode/big-pickle`.
    const isFreeOpenCode = provider === 'opencode' && isWeakerJudge('opencode', runEnv);
    let candidateModels: Array<string | undefined> = [undefined];
    if (isFreeOpenCode) {
      const zdrModels = resolveZdrFreeOpenCodeModels(runEnv);
      const explicitModel = runEnv.OPENCODE_JUDGE_MODEL?.trim();
      if (explicitModel) {
        if (!isZdrFreeOpenCodeModel(explicitModel, runEnv)) {
          attempts.push({
            provider,
            model: explicitModel,
            outcome: 'provider-error',
            failureKind: 'auth',
            reason: `Model "${explicitModel}" is not in the Zero-Data-Retention free OpenCode allowlist.`,
          });
          continue;
        }
        candidateModels = [explicitModel];
      } else if (zdrModels.length === 0) {
        attempts.push({
          provider,
          outcome: 'provider-error',
          failureKind: 'auth',
          reason: 'No Zero-Data-Retention free OpenCode models are configured.',
        });
        continue;
      } else {
        candidateModels = zdrModels;
      }
    }

    try {
      for (const candidateModel of candidateModels) {
        const remainingTotalMs = deadline - Date.now();
        if (remainingTotalMs <= 0) {
          break outer;
        }

        rmSync(verdictPath, { force: true });
        rmSync(reportPath, { force: true });
        const modelEnv =
          isFreeOpenCode && candidateModel
            ? { ...runEnv, OPENCODE_JUDGE_MODEL: candidateModel }
            : runEnv;
        const inv = buildJudgeInvocation(provider, opts.prompt, opts.outDir, modelEnv, opts.maxBudgetUsd ?? '5');
        const timeouts = buildTimeoutsForAttempt(provider, isFreeOpenCode, modelEnv, remainingTotalMs);
        const label = inv.model ? `${provider} (${inv.model})` : provider;
        log(`[judge] trying ${label}`);

        const result = await exec(inv, opts.workdir, modelEnv, timeouts);
        const combined = [result.error?.message, result.abortedProviderError, result.stdout, result.stderr]
          .filter(Boolean)
          .join('\n');
        try {
          writeFileSync(inv.logFile, result.stdout || combined);
          if (result.stderr && result.stdout) {
            writeFileSync(`${inv.logFile}.stderr`, result.stderr);
          }
        } catch {
          // best effort log write
        }

        const parsed = existsSync(verdictPath) ? parseVerdict(readFileSync(verdictPath, 'utf8')) : undefined;
        if (parsed) {
          attempts.push({ provider, ...(inv.model ? { model: inv.model } : {}), outcome: 'verdict', exitCode: result.status });
          log(`[judge] ${label}: verdict (${parsed.verdict})`);
          const meta: JudgeMeta = {
            provider,
            weakerJudge: isWeakerJudge(provider, env),
            source: 'ci',
            ...(inv.model ? { model: inv.model } : {}),
            attempts,
          };
          writeFileSync(join(opts.outDir, 'judge-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
          return { meta, hasVerdict: true };
        }

        if (result.abortedProviderError) {
          const failureKind = classifyProviderFailure(result.abortedProviderError);
          const reason = summarizeError(result.abortedProviderError);
          attempts.push({
            provider,
            ...(inv.model ? { model: inv.model } : {}),
            outcome: 'provider-error',
            failureKind,
            exitCode: result.status,
            reason,
          });
          log(`[judge] ${label}: aborted after provider error (${failureKind}): ${reason}`);
          continue;
        }

        if (result.timedOut) {
          const reason =
            result.timedOut === 'first-activity'
              ? `No answer from ${inv.model ?? provider} within ${formatDuration(timeouts.firstActivityMs)}`
              : result.timedOut === 'idle'
                ? `No output from ${inv.model ?? provider} for ${formatDuration(timeouts.idleMs)}`
                : `${inv.model ?? provider} exceeded ${formatDuration(timeouts.overallMs)} time limit`;
          attempts.push({
            provider,
            ...(inv.model ? { model: inv.model } : {}),
            outcome: 'provider-error',
            failureKind: 'timeout',
            exitCode: result.status,
            reason,
          });
          log(`[judge] ${label}: timed out (${result.timedOut}): ${reason}`);
          continue;
        }

        const failureKind = classifyProviderFailure(combined);
        const modelUnavailable = isFreeOpenCode && MODEL_UNAVAILABLE_RE.test(combined);
        if (result.error || isRetryableProviderFailure(combined) || modelUnavailable) {
          const reason = summarizeError(combined);
          attempts.push({
            provider,
            ...(inv.model ? { model: inv.model } : {}),
            outcome: 'provider-error',
            failureKind,
            exitCode: result.status,
            reason,
          });
          log(`[judge] ${label}: provider-error (${failureKind}): ${reason}`);
          continue;
        }

        const reason = summarizeError(combined) || `exited with ${String(result.status)} without writing verdict.json`;
        attempts.push({
          provider,
          ...(inv.model ? { model: inv.model } : {}),
          outcome: 'no-verdict',
          failureKind: 'other',
          exitCode: result.status,
          reason,
        });
        log(`[judge] ${label}: no-verdict: ${reason}`);
        const meta: JudgeMeta = {
          provider,
          weakerJudge: isWeakerJudge(provider, env),
          source: 'ci',
          ...(inv.model ? { model: inv.model } : {}),
          attempts,
        };
        writeFileSync(join(opts.outDir, 'judge-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
        return { meta, hasVerdict: false };
      }
    } finally {
      if (codexAuth && typeof codexAuth === 'object') codexAuth.restore();
    }
  }

  const meta: JudgeMeta = {
    provider: null,
    weakerJudge: false,
    source: 'ci',
    allProvidersFailed: true,
    attempts,
  };
  writeFileSync(join(opts.outDir, 'judge-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { meta, hasVerdict: false };
}

function summarizeError(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => stripAnsi(l).trim())
    .filter(Boolean);
  const interesting = lines.find((l) => /error|401|403|429|quota|limit|expired|unauthorized|not found|enoent/i.test(l));
  return (interesting ?? lines.at(-1) ?? '').slice(0, 200);
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes('--scrub')) {
      const dir = arg('--scrub');
      const removed = scrubSecretsFromDir(dir, process.env);
      for (const file of removed) {
        process.stdout.write(`Removed ${file}: it contained a secret.\n`);
      }
      process.exit(0);
    }

    const promptFile = arg('--prompt-file');
    const outDir = arg('--out');
    const workdir = process.argv.includes('--workdir') ? arg('--workdir') : process.cwd();
    const maxBudgetUsd = process.argv.includes('--max-budget-usd') ? arg('--max-budget-usd') : '5';
    const prompt = readFileSync(promptFile, 'utf8');
    const { meta, hasVerdict } = await runJudge({
      prompt,
      outDir,
      workdir,
      maxBudgetUsd,
      inDir: dirname(resolve(promptFile)),
    });
    process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
    process.exit(hasVerdict ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
