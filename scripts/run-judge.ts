// Runs the independent Verdict judge across configured CI providers in priority order (ADR 0013).
// Tries Codex first, then Claude, then free OpenCode by default (configurable via CI_PROVIDER_ORDER
// or JUDGE_PROVIDER). Falls back only when credentials are missing or a provider hits an auth,
// billing, quota, or missing-CLI error — never after a valid FAIL verdict.
//
//   node scripts/run-judge.ts --prompt-file <file> --out <dir> [--workdir <dir>] [--max-budget-usd <n>]
//   node scripts/run-judge.ts --scrub <dir>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyProviderFailure,
  hasProviderCredentials,
  isRetryableProviderFailure,
  isWeakerJudge,
  type JudgeProvider,
  materializeCodexAuth,
  type ProviderFailureKind,
  resolveProviderOrder,
  scrubSecretsFromDir,
} from './ci-providers.ts';
import { parseVerdict } from './verdict.ts';

export interface JudgeAttempt {
  provider: JudgeProvider;
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
  command: string;
  args: string[];
  stdin?: string;
  model?: string;
  logFile: string;
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
    return { command: 'codex', args, stdin: prompt, ...(model ? { model } : {}), logFile: join(outDir, 'judge-codex.log') };
  }
  if (provider === 'claude') {
    const model = env.CLAUDE_JUDGE_MODEL?.trim() || env.JUDGE_MODEL?.trim() || 'opus';
    return {
      command: 'claude',
      args: ['-p', prompt, '--model', model, '--max-budget-usd', maxBudgetUsd, '--dangerously-skip-permissions', '--output-format', 'json'],
      model,
      logFile: join(outDir, 'claude.json'),
    };
  }
  const model = env.OPENCODE_JUDGE_MODEL?.trim() || undefined;
  const args = ['run'];
  if (model) args.push('-m', model);
  args.push(prompt);
  return { command: 'opencode', args, ...(model ? { model } : {}), logFile: join(outDir, 'judge-opencode.log') };
}

export interface RunJudgeDeps {
  env?: NodeJS.ProcessEnv;
  exec?: (inv: JudgeInvocation, workdir: string, env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string; error?: Error };
  hasCredentials?: (provider: JudgeProvider, env: NodeJS.ProcessEnv) => { configured: boolean; source?: string };
  materializeCodex?: (env: NodeJS.ProcessEnv) => { path: string; codexHome?: string; restore: () => void } | string | undefined;
}

function defaultExec(inv: JudgeInvocation, workdir: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(inv.command, inv.args, {
    cwd: workdir,
    env,
    input: inv.stdin ?? '',
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Runs configured judge providers in order until one writes a valid verdict.json or all fail. */
export function runJudge(
  opts: { prompt: string; outDir: string; workdir: string; maxBudgetUsd?: string },
  deps: RunJudgeDeps = {},
): { meta: JudgeMeta; hasVerdict: boolean } {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const checkCreds = deps.hasCredentials ?? ((p, e) => hasProviderCredentials(p, e));
  const prepareCodex = deps.materializeCodex ?? ((e) => materializeCodexAuth(e));

  mkdirSync(opts.outDir, { recursive: true });
  const order = resolveProviderOrder('judge', env);
  const attempts: JudgeAttempt[] = [];
  const verdictPath = join(opts.outDir, 'verdict.json');
  const reportPath = join(opts.outDir, 'verdict.md');

  for (const provider of order) {
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

    const runEnv: NodeJS.ProcessEnv =
      codexAuth && typeof codexAuth === 'object' && codexAuth.codexHome
        ? { ...env, CODEX_HOME: codexAuth.codexHome }
        : env;
    const inv = buildJudgeInvocation(provider, opts.prompt, opts.outDir, runEnv, opts.maxBudgetUsd ?? '5');
    let result: ReturnType<typeof defaultExec>;
    try {
      result = exec(inv, opts.workdir, runEnv);
    } finally {
      if (codexAuth && typeof codexAuth === 'object') codexAuth.restore();
    }
    const combined = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
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
      attempts.push({ provider, outcome: 'verdict', exitCode: result.status });
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

    const failureKind = classifyProviderFailure(combined);
    if (result.error || isRetryableProviderFailure(combined)) {
      attempts.push({
        provider,
        outcome: 'provider-error',
        failureKind,
        exitCode: result.status,
        reason: summarizeError(combined),
      });
      continue;
    }

    attempts.push({
      provider,
      outcome: 'no-verdict',
      failureKind: 'other',
      exitCode: result.status,
      reason: summarizeError(combined) || `exited with ${String(result.status)} without writing verdict.json`,
    });
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
    .map((l) => l.trim())
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
    const { meta, hasVerdict } = runJudge({ prompt, outDir, workdir, maxBudgetUsd });
    process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
    process.exit(hasVerdict ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
