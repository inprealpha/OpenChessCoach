// The independent Verdict (ADR 0013). `.github/workflows/verdict.yml` runs a fresh Claude Code
// session that did not write the PR; it writes `verdict.json` (and `verdict.md`, the comment) and
// this script turns them into the "Verdict" status on the PR's head commit and a PR comment. A
// missing or malformed verdict posts an error, so a judge that crashed or ran out of time never
// reads as a pass.
//
//   node scripts/verdict.ts --post <dir> --pr <n> --sha <sha> --run-url <url>
//       read <dir>/verdict.json and <dir>/verdict.md, post the status and comment on the PR; if the
//       judge job wrote <dir>/skipped instead, post that reason as an error and no comment
//   node scripts/verdict.ts --status <state> --sha <sha> --description <text> [--context <name>]
//       post a status the workflow decides on its own (pending, an error, a pass for docs only),
//       on "Verdict" unless --context names another (the workflow posts "real Coach" this way)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERDICT_CONTEXT = 'Verdict';
/** GitHub cuts a status description at 140 characters. */
const MAX_DESCRIPTION = 140;
/** A Verdict comment from a run that started the judge starts with this, so the workflow can count them. */
export const COMMENT_MARKER = '<!-- verdict';

export type VerdictWord = 'PASS' | 'PASS+NOTES' | 'FAIL';
export type StatusState = 'success' | 'failure' | 'error' | 'pending';

export interface JudgeVerdict {
  verdict: VerdictWord;
  summary: string;
}

/** Reads the judge's verdict.json; anything but a known verdict word with a summary is no verdict. */
export function parseVerdict(text: string | undefined): JudgeVerdict | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as Partial<JudgeVerdict>;
    if ((v.verdict === 'PASS' || v.verdict === 'PASS+NOTES' || v.verdict === 'FAIL') && typeof v.summary === 'string' && v.summary.trim()) {
      return { verdict: v.verdict, summary: v.summary.trim() };
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function clip(text: string, max = MAX_DESCRIPTION): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The status a verdict posts: PASS and PASS+NOTES pass, FAIL fails, no verdict is an error. */
export function statusFor(verdict: JudgeVerdict | undefined, started = true): { state: StatusState; description: string } {
  if (!verdict && !started) return { state: 'error', description: "The judge didn't start (setting up the app failed): comment /verdict to try again" };
  if (!verdict) return { state: 'error', description: 'The judge gave no verdict (it crashed, ran out of time or hit its spending limit): comment /verdict to run it again' };
  return { state: verdict.verdict === 'FAIL' ? 'failure' : 'success', description: clip(`${verdict.verdict}: ${verdict.summary}`) };
}

/** A judge job that stopped because the PR changed posts its reason as an error, and no comment. */
export function skippedStatus(reason: string | undefined): { state: StatusState; description: string } | undefined {
  return reason?.trim() ? { state: 'error', description: clip(reason) } : undefined;
}

/**
 * The PR comment: the verdict and its commit, the judge's own write-up, and the run. It carries the
 * marker only when the judge started, so a run that failed while setting up uses none of the limits.
 */
export function commentFor(verdict: JudgeVerdict | undefined, body: string | undefined, sha: string, runUrl: string, started = true): string {
  const head = verdict ? `## Verdict: ${verdict.verdict}\n\n${verdict.summary}` : `## Verdict: none\n\n${statusFor(undefined, started).description.replace('/verdict', '`/verdict`')}.`;
  const parts = [...(started ? [`${COMMENT_MARKER} sha=${sha} -->`] : []), head, `For commit ${sha}. A new push needs a new Verdict.`];
  if (verdict && body?.trim()) parts.push(body.trim());
  parts.push(`Screenshots, logs and the judge's full output: [the workflow run](${runUrl}) (artifact \`verdict-evidence\`).`);
  return `${parts.join('\n\n')}\n`;
}

/** Runs gh, up to three times: one failed call (GitHub answered once with an empty body) mustn't leave a stale status. */
function gh(args: string[], input?: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('gh', args, { input, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'inherit'] });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5000);
    }
  }
}

function postStatus(sha: string, state: StatusState, description: string, context = VERDICT_CONTEXT): void {
  gh(['api', `repos/{owner}/{repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${clip(description)}`]);
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes('--post')) {
      const dir = arg('--post');
      const sha = arg('--sha');
      // The judge job stopped before judging because the PR changed while the gate waited for CI.
      const skipped = skippedStatus(read(join(dir, 'skipped')));
      if (skipped) {
        postStatus(sha, skipped.state, skipped.description);
        process.stdout.write(`${skipped.state}: ${skipped.description}\n`);
        process.exit(0);
      }
      const verdict = parseVerdict(read(join(dir, 'verdict.json')));
      const started = existsSync(join(dir, 'started'));
      const comment = commentFor(verdict, read(join(dir, 'verdict.md')), sha, arg('--run-url'), started);
      // The status first: a comment that fails must not leave the commit pending forever.
      const { state, description } = statusFor(verdict, started);
      postStatus(sha, state, description);
      process.stdout.write(`${state}: ${description}\n`);
      gh(['pr', 'comment', arg('--pr'), '--body-file', '-'], comment);
    } else if (process.argv.includes('--status')) {
      const state = arg('--status') as StatusState;
      if (!['success', 'failure', 'error', 'pending'].includes(state)) throw new Error(`Unknown state ${state}.`);
      const description = arg('--description');
      const context = process.argv.includes('--context') ? arg('--context') : VERDICT_CONTEXT;
      postStatus(arg('--sha'), state, description, context);
      process.stdout.write(`${state}: ${description}\n`);
    } else {
      throw new Error('Pass --post or --status.');
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
