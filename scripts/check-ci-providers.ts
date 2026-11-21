// Weekly health check for configured CI provider logins (ADR 0013).
// Probes every configured provider (Codex, Claude, OpenCode) with a tiny cheap prompt and, when
// run with --report-issue in GitHub Actions, opens or updates a plain-English GitHub issue if any
// saved login has stopped working (and closes it automatically once all configured logins recover).
//
//   node scripts/check-ci-providers.ts [--report-issue] [--run-url <url>]
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  classifyProviderFailure,
  hasProviderCredentials,
  JUDGE_PROVIDERS,
  type JudgeProvider,
  materializeCodexAuth,
  type ProviderFailureKind,
} from './ci-providers.ts';

export const HEALTH_ISSUE_TITLE = '[CI Provider Health] One or more saved AI logins stopped working';
export const HEALTH_ISSUE_MARKER = '<!-- ci-provider-health -->';

export interface ProviderProbeResult {
  provider: JudgeProvider;
  status: 'ok' | 'skipped' | 'failed';
  source?: string;
  failureKind?: ProviderFailureKind;
  detail: string;
}

const PROBE_PROMPT = 'Reply with the single word OK.';

function runProbeCommand(
  provider: JudgeProvider,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  if (provider === 'codex') {
    materializeCodexAuth(env);
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-'];
    const r = spawnSync('codex', args, { env, input: PROBE_PROMPT, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
  }
  if (provider === 'claude') {
    const args = ['-p', PROBE_PROMPT, '--model', 'haiku', '--max-budget-usd', '0.10', '--output-format', 'text'];
    const r = spawnSync('claude', args, { env, input: '', encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
  }
  const r = spawnSync('opencode', ['run', PROBE_PROMPT], { env, input: '', encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
}

export interface CheckProvidersDeps {
  env?: NodeJS.ProcessEnv;
  hasCredentials?: (provider: JudgeProvider, env: NodeJS.ProcessEnv) => { configured: boolean; source?: string };
  probe?: (provider: JudgeProvider, env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string; error?: Error };
}

/** Probes every configured CI provider and returns a structured health report. */
export function checkCiProviders(deps: CheckProvidersDeps = {}): ProviderProbeResult[] {
  const env = deps.env ?? process.env;
  const checkCreds = deps.hasCredentials ?? ((p, e) => hasProviderCredentials(p, e));
  const probe = deps.probe ?? runProbeCommand;
  const results: ProviderProbeResult[] = [];

  for (const provider of JUDGE_PROVIDERS) {
    const creds = checkCreds(provider, env);
    if (!creds.configured) {
      results.push({ provider, status: 'skipped', detail: 'No secret saved in GitHub Secrets.' });
      continue;
    }
    try {
      const res = probe(provider, env);
      const combined = [res.error?.message, res.stdout, res.stderr].filter(Boolean).join('\n').trim();
      if (!res.error && res.status === 0 && res.stdout.trim().length > 0) {
        results.push({
          provider,
          status: 'ok',
          ...(creds.source ? { source: creds.source } : {}),
          detail: 'Responded normally.',
        });
      } else {
        const failureKind = classifyProviderFailure(combined);
        results.push({
          provider,
          status: 'failed',
          ...(creds.source ? { source: creds.source } : {}),
          failureKind,
          detail: explainFailure(provider, failureKind, combined),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failureKind = classifyProviderFailure(msg);
      results.push({
        provider,
        status: 'failed',
        ...(creds.source ? { source: creds.source } : {}),
        failureKind,
        detail: explainFailure(provider, failureKind, msg),
      });
    }
  }
  return results;
}

function explainFailure(provider: JudgeProvider, kind: ProviderFailureKind, raw: string): string {
  const snippet = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .slice(0, 180);
  if (kind === 'auth') {
    return `Login/key was rejected or expired for ${provider}. Update or remove its secret in GitHub Settings → Secrets and variables → Actions.${snippet ? ` (${snippet})` : ''}`;
  }
  if (kind === 'quota') {
    return `${provider} hit a billing, credit, or rate limit. Check billing/limits or wait for reset.${snippet ? ` (${snippet})` : ''}`;
  }
  if (kind === 'missing-cli') {
    return `The ${provider} CLI was not found on the runner.${snippet ? ` (${snippet})` : ''}`;
  }
  return snippet || `${provider} probe failed without output.`;
}

/** Builds a plain-English GitHub issue body listing every provider's status and how to fix failures. */
export function formatHealthIssueBody(results: readonly ProviderProbeResult[], runUrl?: string): string {
  const failed = results.filter((r) => r.status === 'failed');
  const rows = results.map((r) => `| **${r.provider}** | ${r.status} | ${r.source ?? '—'} | ${r.detail} |`);
  const parts = [
    HEALTH_ISSUE_MARKER,
    `The weekly CI provider health check found **${failed.length}** broken provider login${failed.length === 1 ? '' : 's'}.`,
    'CI will automatically fall back to the next working provider in `CI_PROVIDER_ORDER`, so PRs can keep moving, but you should refresh or remove the broken secret so you are not silently relying on a fallback.',
    ['| Provider | Status | Credential | Details |', '| --- | --- | --- | --- |', ...rows].join('\n'),
    '### How to fix\n\n1. Open **Settings → Secrets and variables → Actions → Secrets** in this repository.\n2. Update any expired secret with a fresh key/token, or delete it if you paused that subscription.\n3. Re-run the **CI Provider Health** workflow from the **Actions** tab to confirm it passes (this issue will close automatically once all saved logins pass).\n\nFull plain-English guide: `docs/ci-providers.md`.',
  ];
  if (runUrl) parts.push(`Workflow run: ${runUrl}`);
  return `${parts.join('\n\n')}\n`;
}

function findOpenHealthIssue(): number | undefined {
  const out = execFileSync(
    'gh',
    ['issue', 'list', '--state', 'open', '--search', `"${HEALTH_ISSUE_TITLE}" in:title`, '--json', 'number,title,body'],
    { encoding: 'utf8' },
  );
  const issues = JSON.parse(out) as Array<{ number: number; title: string; body: string }>;
  return issues.find((i) => i.body?.includes(HEALTH_ISSUE_MARKER) || i.title === HEALTH_ISSUE_TITLE)?.number;
}

function reportHealthIssue(results: readonly ProviderProbeResult[], runUrl?: string): void {
  const failed = results.filter((r) => r.status === 'failed');
  const existing = findOpenHealthIssue();
  if (failed.length > 0) {
    const body = formatHealthIssueBody(results, runUrl);
    if (existing) {
      execFileSync('gh', ['issue', 'comment', String(existing), '--body-file', '-'], { input: body, stdio: ['pipe', 'inherit', 'inherit'] });
    } else {
      execFileSync('gh', ['issue', 'create', '--title', HEALTH_ISSUE_TITLE, '--body-file', '-'], { input: body, stdio: ['pipe', 'inherit', 'inherit'] });
    }
    return;
  }
  if (existing) {
    const note = `All configured CI provider logins passed the latest health check${runUrl ? ` (${runUrl})` : ''}. Closing this issue automatically.\n`;
    execFileSync('gh', ['issue', 'comment', String(existing), '--body-file', '-'], { input: note, stdio: ['pipe', 'inherit', 'inherit'] });
    execFileSync('gh', ['issue', 'close', String(existing)], { stdio: 'inherit' });
  }
}

function optionalArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = checkCiProviders();
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (process.argv.includes('--report-issue')) {
    reportHealthIssue(results, optionalArg('--run-url'));
  }
  const anyFailed = results.some((r) => r.status === 'failed');
  process.exit(anyFailed ? 1 : 0);
}
