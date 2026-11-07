// Checks on a PR's description, for the labels `.github/workflows/pr-labels.yml` sets (ADR 0006):
//   no-evidence        the Evidence section is empty
//   no-testing-record  the "How this was made" section doesn't say which model made the change,
//                      how it was tested (at least one ticked box) and what was not tested
//   no-spec            the description closes no issue ("Closes #12"), so there is nothing agreed to prove
//   unproven           the "Done means" section has a check that isn't ticked, or none at all
// HTML comments never count, so the template's own hints are not an answer.
//
// And whether an agent may merge a PR (ADR 0014): only what the owner approved (the merge-approved
// label on every issue it closes), with a PASS from the Verdict and green CI on its head commit, no
// protected path and no missing record. Anything else waits for the owner.
//
//   node scripts/pr-description.ts < body.md     print the labels the PR needs, one per line,
//                                                 and what is missing to stderr
//   node scripts/pr-description.ts --may-merge <pr>
//                                                 print {"mayMerge", "sha", "met", "problems"} as JSON
//                                                 and exit 0 only when an agent may merge <pr>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matching, readList } from './protected-paths.ts';

export const NO_EVIDENCE = 'no-evidence';
export const NO_TESTING_RECORD = 'no-testing-record';
export const NO_SPEC = 'no-spec';
export const UNPROVEN = 'unproven';
export const PROTECTED_PATH = 'protected-path';
export const MERGE_APPROVED = 'merge-approved';

/** The CI jobs and checks that must pass on the head commit before an agent merges. */
export const REQUIRED_CHECKS = ['Checks', 'Player journeys', 'Label for review'] as const;
/** The Verdict status a PR that changes only docs, tests or process files gets at once (ADR 0013). */
const NO_VERDICT_NEEDED = 'Changes only docs, tests or process files';

/** The text with every HTML comment removed, including comments over several lines and one left open. */
export function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/**
 * The text under the first `## <heading>` line (a heading that starts with those words, such as
 * "## Evidence (desktop and phone)"), up to the next `## ` heading, or undefined when there is none.
 * Lines inside fenced code blocks are never headings.
 */
export function section(body: string, heading: string): string | undefined {
  const lines = withoutComments(body).replace(/\r\n/g, '\n').split('\n');
  let fenced = false;
  const isHeading = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return !fenced && /^## /.test(l);
  });
  const wanted = heading.toLowerCase();
  const start = lines.findIndex((l, i) => isHeading[i] && l.slice(3).trim().toLowerCase().startsWith(wanted));
  if (start < 0) return undefined;
  const end = isHeading.findIndex((h, i) => h && i > start);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The text without fenced code blocks (one left open runs to the end), so an example in code is never an answer. */
export function withoutCode(text: string): string {
  return text.replace(/^[ \t]*(```|~~~)[\s\S]*?(?:^[ \t]*\1|(?![\s\S]))/gm, '');
}

export function hasEvidence(body: string): boolean {
  return (section(body, 'Evidence') ?? '').trim() !== '';
}

/** What the "How this was made" section is missing, in plain words; empty when it is complete. */
export function testingRecordProblems(body: string): string[] {
  const found = section(body, 'How this was made');
  if (found === undefined) return ['There is no "How this was made" section.'];
  const text = withoutCode(found);
  const problems: string[] = [];
  if (!/^[ \t]*Made (?:with|by)[ \t]+\S/im.test(text)) problems.push('The "Made with" line is missing or empty.');
  if (!/^[ \t]*[-*][ \t]+\[[xX]\][ \t]+\S/m.test(text)) problems.push('No testing method is ticked.');
  if (!/^[ \t]*Not tested:[ \t]*\S/im.test(text)) problems.push('The "Not tested" line is missing or empty; write "nothing" if nothing was left out.');
  return problems;
}

/**
 * The issues the description closes, with GitHub's own closing words ("Closes #12", "Fixes #3",
 * "Resolves #4"), outside comments and code. "Closes #" with no number closes nothing.
 */
export function closedIssues(body: string): number[] {
  const text = withoutCode(withoutComments(body)).replace(/`[^`\n]*`/g, '');
  const found = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)].map((m) => Number(m[1]));
  return [...new Set(found)];
}

/** What the "Done means" section is missing, in plain words; empty when every check is ticked. */
export function unprovenProblems(body: string): string[] {
  const found = section(body, 'Done means');
  if (found === undefined) return ['There is no "Done means" section.'];
  const text = withoutCode(found);
  const boxes = [...text.matchAll(/^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*(.*)$/gm)].map((m) => ({ ticked: m[1] !== ' ', text: (m[2] ?? '').trim() }));
  if (!boxes.some((b) => b.ticked && b.text)) return ['No "Done means" check is ticked.'];
  return boxes.filter((b) => !b.ticked || !b.text).map((b) => (b.text ? `"Done means" check not proven: ${b.text}` : 'A "Done means" check is empty.'));
}

/** The labels the PR's description earns. */
export function labelsFor(body: string): string[] {
  return [
    ...(hasEvidence(body) ? [] : [NO_EVIDENCE]),
    ...(testingRecordProblems(body).length ? [NO_TESTING_RECORD] : []),
    ...(closedIssues(body).length ? [] : [NO_SPEC]),
    ...(unprovenProblems(body).length ? [UNPROVEN] : []),
  ];
}

/** Everything the merge decision needs to know about a PR, read from GitHub at one moment. */
export interface PrFacts {
  /** Open, and not a draft. */
  open: boolean;
  draft: boolean;
  body: string;
  /** The PR's labels, as the labelling workflow set them from the base branch's lists. */
  labels: readonly string[];
  /** The labels of each issue the description closes, by issue number. */
  issueLabels: Readonly<Record<number, readonly string[]>>;
  /** The head commit's statuses by context (the newest of each), such as "Verdict" and "real Coach". */
  statuses: Readonly<Record<string, { state: string; description: string } | undefined>>;
  /** The head commit's check runs by name: every run's conclusion, or null while it runs. */
  checks: Readonly<Record<string, readonly (string | null)[] | undefined>>;
  /** The changed files that are on the base branch's protected-path list. */
  protectedFiles: readonly string[];
}

export interface MergeDecision {
  mayMerge: boolean;
  /** Each rule that holds, in plain words, for the comment the merge leaves. */
  met: string[];
  /** Each rule that doesn't hold, in plain words. */
  problems: string[];
}

/** Whether a check passed: at least one run succeeded and none failed or is still running. Skipped runs don't count either way. */
function checkPassed(runs: readonly (string | null)[] | undefined): boolean {
  if (!runs?.length) return false;
  const counted = runs.filter((c) => c !== 'skipped' && c !== 'neutral');
  return counted.includes('success') && counted.every((c) => c === 'success');
}

/** Whether an agent may merge the PR (ADR 0014), with the reason for each rule. */
export function mergeDecision(f: PrFacts): MergeDecision {
  const met: string[] = [];
  const problems: string[] = [];
  const rule = (ok: boolean, yes: string, no: string) => (ok ? met : problems).push(ok ? yes : no);

  rule(f.open && !f.draft, 'The PR is open and ready for review.', f.open ? 'The PR is a draft.' : 'The PR is not open.');

  const issues = closedIssues(f.body);
  if (!issues.length) problems.push('The description closes no issue, so nothing the owner agreed to can be checked.');
  for (const n of issues) {
    const approved = (f.issueLabels[n] ?? []).includes(MERGE_APPROVED);
    rule(approved, `The owner approved merging issue #${n} (${MERGE_APPROVED}).`, `Issue #${n} has no ${MERGE_APPROVED} label: the owner hasn't approved merging it.`);
  }

  const verdict = f.statuses.Verdict;
  const verdictText = verdict?.description ?? '';
  const passed = verdict?.state === 'success' && (verdictText.startsWith('PASS:') || verdictText.startsWith(NO_VERDICT_NEEDED));
  if (passed) met.push(`The Verdict on this commit: ${verdictText}`);
  else if (verdict?.state === 'success' && verdictText.startsWith('PASS+NOTES')) problems.push('The Verdict is PASS+NOTES: the owner reads the notes and merges.');
  else problems.push(`There is no passing Verdict on this commit${verdict ? ` (${verdict.state}: ${verdictText})` : ''}.`);

  const coach = f.statuses['real Coach'];
  rule(coach?.state === 'success', 'The real Coach status passes.', `The real Coach status doesn't pass${coach ? ` (${coach.state}: ${coach.description})` : ''}.`);

  for (const name of REQUIRED_CHECKS) rule(checkPassed(f.checks[name]), `${name} passed on this commit.`, `${name} hasn't passed on this commit.`);

  const descriptionLabels = labelsFor(f.body);
  const missing = [NO_EVIDENCE, NO_TESTING_RECORD, NO_SPEC, UNPROVEN].filter((l) => f.labels.includes(l) || descriptionLabels.includes(l));
  rule(!missing.length, 'The description has its evidence, testing record, issue and proven checks.', `The description's record is incomplete: ${missing.join(', ')}.`);
  if (descriptionLabels.includes(UNPROVEN)) problems.push(...unprovenProblems(f.body));

  const touched = f.protectedFiles.length > 0 || f.labels.includes(PROTECTED_PATH);
  rule(
    !touched,
    'The PR touches no protected path.',
    `The PR touches protected paths, which the owner always merges${f.protectedFiles.length ? `: ${f.protectedFiles.join(', ')}` : ''}.`,
  );

  return { mayMerge: problems.length === 0, met, problems };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Reads a PR's facts from GitHub. The protected-path list comes from the PR's base branch, so a PR can't exempt itself. */
export function readFacts(pr: number): PrFacts & { sha: string } {
  const view = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'state,isDraft,body,labels,headRefOid,baseRefName,files'])) as {
    state: string; isDraft: boolean; body: string; labels: { name: string }[]; headRefOid: string; baseRefName: string; files: { path: string }[];
  };
  const sha = view.headRefOid;
  const issueLabels: Record<number, string[]> = {};
  for (const n of closedIssues(view.body)) {
    try {
      issueLabels[n] = (JSON.parse(gh(['issue', 'view', String(n), '--json', 'labels'])) as { labels: { name: string }[] }).labels.map((l) => l.name);
    } catch {
      issueLabels[n] = [];
    }
  }
  const statuses: Record<string, { state: string; description: string }> = {};
  const combined = JSON.parse(gh(['api', `repos/{owner}/{repo}/commits/${sha}/status`])) as { statuses: { context: string; state: string; description: string | null }[] };
  for (const s of combined.statuses) statuses[s.context] ??= { state: s.state, description: s.description ?? '' };
  const checks: Record<string, (string | null)[]> = {};
  const runs = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`])) as { check_runs: { name: string; conclusion: string | null }[] }[];
  for (const r of runs.flatMap((p) => p.check_runs)) (checks[r.name] ??= []).push(r.conclusion);
  const list = readList(gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/{owner}/{repo}/contents/.github/protected-paths.txt?ref=${view.baseRefName}`]));
  return {
    sha,
    open: view.state === 'OPEN',
    draft: view.isDraft,
    body: view.body,
    labels: view.labels.map((l) => l.name),
    issueLabels,
    statuses,
    checks,
    protectedFiles: matching(view.files.map((f) => f.path), list),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--may-merge') {
    const pr = Number(process.argv[3]);
    if (!Number.isInteger(pr) || pr <= 0) {
      console.error('Usage: node scripts/pr-description.ts --may-merge <pr number>');
      process.exit(2);
    }
    const { sha, ...facts } = readFacts(pr);
    const decision = mergeDecision(facts);
    console.log(JSON.stringify({ pr, sha, ...decision }, null, 2));
    process.exit(decision.mayMerge ? 0 : 1);
  }
  const body = readFileSync(0, 'utf8');
  if (!hasEvidence(body)) console.error('The Evidence section is empty.');
  for (const problem of testingRecordProblems(body)) console.error(problem);
  if (!closedIssues(body).length) console.error('The description closes no issue: write "Closes #<number>".');
  for (const problem of unprovenProblems(body)) console.error(problem);
  for (const label of labelsFor(body)) console.log(label);
}
