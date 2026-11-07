// Waits for a PR's CI on its head commit, and only CI: never for the judges' statuses.
//
// The "Verdict" status (ADR 0013) and the "real Coach" status stay pending whenever they aren't
// running: on a draft, and after a push until someone comments /verdict. A command that waits for
// every check, such as `gh pr checks --watch`, then waits forever. This script waits until the
// required CI checks have run and every other CI check has finished, skipping the judges and
// previews, and gives up after a time limit. A Claude Code hook (.claude/hooks/no-watch-all-checks.ts)
// stops sessions from running the wait-for-everything command.
//
//   npm run -s wait:ci -- <pr> [--sha SHA] [--timeout-minutes 30] [--interval 30]
//
// It waits for the commit this checkout is at when the checkout is on the PR's branch (so a wait
// started right after `git push` never reports the commit before it), else for --sha, else for the
// PR's head. Prints one line per check and the statuses it didn't wait for, then exits:
//   0  every CI check passed (or was skipped)
//   1  a CI check failed or was cancelled, or the PR has a merge conflict, so CI can't run
//   2  a usage error, or GitHub couldn't be read
//   3  the time limit ran out, the PR got another commit, or the commit never reached the PR
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CHECKS } from './pr-description.ts';

/** Statuses posted by the judges, not by CI: they stay pending until a judge runs. */
export const JUDGE_STATUSES = ['Verdict', 'real Coach'] as const;
/**
 * Workflows whose jobs aren't CI: the Verdict's jobs wait for CI and then for the judge, and a
 * preview waits in the box's queue, where a newer one replaces it (it then shows as cancelled).
 */
export const NOT_CI_WORKFLOWS = ['Verdict', 'Preview'] as const;
/** How long a commit may take to show as the PR's head after a push, before the wait gives up. */
export const PUSH_GRACE_MS = 120_000;
/** A pass is read twice, this far apart, so jobs that register a little later still count. */
export const CONFIRM_MS = 10_000;
/** gh errors in a row before the wait gives up: one network blip doesn't end a long wait. */
export const MAX_ERRORS = 3;

/** One row of `gh pr checks --json name,state,bucket,workflow,event,description`. */
export interface Check {
  name: string;
  state: string;
  /** gh's grouping of the state: pass, fail, pending, skipping or cancel. */
  bucket: string;
  /** The workflow's name for a job; empty for a commit status. */
  workflow: string;
  /** The event that started a job (pull_request, push, …); empty for a commit status. */
  event?: string;
  description?: string;
}

export interface Progress {
  done: boolean;
  passed: boolean;
  /** The CI checks waited for, finished or not. */
  ci: Check[];
  /** Rows shown but never waited for: the judges' statuses and previews. */
  other: Check[];
  /** Required checks that haven't run on the head commit yet. */
  missing: string[];
}

/** Whether a row is CI: not a judge's status, not a job of the Verdict or Preview workflows. */
export function isCi(c: Check): boolean {
  if (!c.workflow) return !(JUDGE_STATUSES as readonly string[]).includes(c.name);
  return !(NOT_CI_WORKFLOWS as readonly string[]).includes(c.workflow);
}

/** Where CI stands, from the head commit's checks. */
export function progress(checks: Check[], required: readonly string[] = REQUIRED_CHECKS): Progress {
  // ci.yml also runs on push and skips its jobs on every branch but main, so each PR head carries
  // skipped push-event copies of the CI jobs. They say nothing about the PR: leave them out.
  const ci = checks.filter((c) => isCi(c) && !(c.event === 'push' && c.bucket === 'skipping'));
  const other = checks.filter((c) => !isCi(c));
  // A required check has run only when it has a row that wasn't skipped.
  const missing = required.filter((name) => !ci.some((c) => c.name === name && c.bucket !== 'skipping'));
  const failed = ci.some((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const waiting = missing.length > 0 || ci.some((c) => c.bucket === 'pending');
  return { done: failed || !waiting, passed: !failed && !waiting, ci, other, missing };
}

/** One line per check, then the rows it didn't wait for, for a person to read. */
export function report(p: Progress): string {
  const word: Record<string, string> = { pass: 'passed', fail: 'failed', cancel: 'cancelled', skipping: 'skipped', pending: 'still running' };
  const lines = p.ci.map((c) => `  ${word[c.bucket] ?? c.state}: ${c.workflow ? `${c.workflow} / ` : ''}${c.name}`);
  for (const name of p.missing) lines.push(`  hasn't run yet: ${name}`);
  // The Verdict workflow's own jobs (Gate, Judge, Post the Verdict) only repeat what its status says.
  for (const c of p.other.filter((c) => c.workflow !== 'Verdict')) {
    // A status that is pending isn't running: it waits for someone to start the judge.
    const how = !c.workflow && c.bucket === 'pending' ? 'pending' : (word[c.bucket] ?? c.state).toLowerCase();
    lines.push(`  (not waited for) ${c.name}: ${how}${c.description ? `, ${c.description}` : ''}`);
  }
  return lines.join('\n');
}

const minutesText = (ms: number) => {
  const n = Math.round(ms / 60000);
  return `${n} minute${n === 1 ? '' : 's'}`;
};

type Gh = (args: string[]) => string;
const gh: Gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

interface Pr {
  head: string;
  branch: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN (while GitHub works it out). */
  mergeable: string;
}

function prOf(pr: string, run: Gh): Pr {
  const r = JSON.parse(run(['pr', 'view', pr, '--json', 'headRefOid,headRefName,mergeable']));
  return { head: r.headRefOid, branch: r.headRefName, mergeable: r.mergeable };
}

function checksOf(pr: string, run: Gh): Check[] {
  try {
    return JSON.parse(run(['pr', 'checks', pr, '--json', 'name,state,bucket,workflow,event,description']) || '[]') as Check[];
  } catch (err) {
    // With --json, gh exits 0 whatever the checks say; it exits 1 when the commit has no checks yet.
    if (/no checks reported/i.test(String((err as { stderr?: string }).stderr ?? ''))) return [];
    throw err;
  }
}

/** The commit this checkout is at, when it is on the PR's branch; else undefined. */
export function localHead(branch: string): string | undefined {
  try {
    const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return git('rev-parse', '--abbrev-ref', 'HEAD') === branch ? git('rev-parse', 'HEAD') : undefined;
  } catch {
    return undefined;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  /** The commit to wait for; by default the checkout's, when it is on the PR's branch, else the PR's head. */
  sha?: string;
  run?: Gh;
  local?: (branch: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Waits for CI on the PR's head commit; returns the exit code and what to print. */
export async function waitForCi(pr: string, o: WaitOptions): Promise<{ code: number; text: string }> {
  const run = o.run ?? gh;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const start = now();
  const deadline = start + o.timeoutMs;
  let errors = 0;
  // A gh call that may fail once or twice in a long wait without ending it.
  const read = <T>(f: () => T): T | undefined => {
    try {
      const v = f();
      errors = 0;
      return v;
    } catch (err) {
      if (++errors >= MAX_ERRORS) throw err;
      log(`could not read PR #${pr} from GitHub, trying again`);
      return undefined;
    }
  };

  let first: Pr | undefined;
  while (!first) {
    first = read(() => prOf(pr, run));
    if (!first) await sleep(o.intervalMs);
  }
  const want = o.sha ?? (o.local ?? localHead)(first.branch) ?? first.head;
  const short = want.slice(0, 7);
  let seen = false;
  let passedOnce = false;
  let last = '';
  for (;;) {
    const state = read(() => ({ pr: prOf(pr, run), checks: checksOf(pr, run) }));
    if (state) {
      const at = `PR #${pr} at ${short}`;
      if (state.pr.head.startsWith(want)) seen = true;
      else if (seen) return { code: 3, text: `PR #${pr} got another commit (${state.pr.head.slice(0, 7)}) while waiting for ${short}: run this again.` };
      else if (now() - start >= Math.min(PUSH_GRACE_MS, o.timeoutMs)) {
        return { code: 3, text: `PR #${pr}'s head is ${state.pr.head.slice(0, 7)}, not ${short}: push the commit, or pass --sha.` };
      }
      if (seen) {
        const p = progress(state.checks);
        if (p.missing.length > 0 && state.pr.mergeable === 'CONFLICTING') {
          return { code: 1, text: `${at}: the PR has a merge conflict, so CI doesn't run. Merge the base branch first.\n${report(p)}` };
        }
        // A pass counts once it holds on a second look: some jobs register seconds after others.
        if (p.done && (!p.passed || passedOnce)) {
          return { code: p.passed ? 0 : 1, text: `${at}: CI ${p.passed ? 'passed' : 'failed'}.\n${report(p)}` };
        }
        passedOnce = p.passed;
        const waitingFor = [...p.missing, ...p.ci.filter((c) => c.bucket === 'pending').map((c) => c.name)].join(', ');
        if (waitingFor && waitingFor !== last) log(`${at}: waiting for ${waitingFor}`);
        last = waitingFor;
        if (!passedOnce && now() >= deadline) return { code: 3, text: `${at}: CI hasn't finished after ${minutesText(o.timeoutMs)}.\n${report(p)}` };
      } else if (last !== 'push') {
        log(`PR #${pr}: waiting for GitHub to show ${short} as the PR's head`);
        last = 'push';
      }
    }
    await sleep(passedOnce ? Math.min(CONFIRM_MS, o.intervalMs) : Math.min(o.intervalMs, Math.max(1000, deadline - now())));
  }
}

function usage(): never {
  console.error('usage: npm run -s wait:ci -- <pr> [--sha SHA] [--timeout-minutes N] [--interval SECONDS]');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let pr = '';
  let sha: string | undefined;
  let timeoutMinutes = 30;
  let seconds = 30;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--timeout-minutes') timeoutMinutes = Number(args[++i] ?? NaN);
    else if (a === '--interval') seconds = Number(args[++i] ?? NaN);
    else if (a === '--sha' && /^[0-9a-f]{7,40}$/.test(args[i + 1] ?? '')) sha = args[++i];
    else if (/^\d+$/.test(a) && !pr) pr = a;
    else usage();
  }
  if (!pr || !(timeoutMinutes > 0) || !(seconds >= 5)) usage();
  try {
    const { code, text } = await waitForCi(pr, {
      timeoutMs: timeoutMinutes * 60_000,
      intervalMs: seconds * 1000,
      ...(sha ? { sha } : {}),
      log: (line) => console.error(line),
    });
    console.log(text);
    process.exit(code);
  } catch (err) {
    console.error(`could not read PR #${pr} from GitHub: ${String((err as { stderr?: string }).stderr ?? err).trim()}`);
    process.exit(2);
  }
}
