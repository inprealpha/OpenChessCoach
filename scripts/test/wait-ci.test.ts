// Waiting for CI never waits for the judges: the Verdict and real Coach statuses stay pending until a
// judge runs, so a wait that counts them never ends. It never passes before CI has run on the commit
// that was pushed. And the Claude Code hook stops a session from running `gh pr checks --watch`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGE, watchesAllChecks } from '../../.claude/hooks/no-watch-all-checks.ts';
import { type Check, progress, waitForCi } from '../wait-ci.ts';

const required = ['Checks', 'Player journeys', 'Label for review'];
const job = (name: string, bucket: string, workflow = 'CI', event = 'pull_request'): Check => ({ name, bucket, workflow, event, state: bucket.toUpperCase() });
const status = (name: string, bucket: string, description = ''): Check => ({ name, bucket, workflow: '', event: '', state: bucket.toUpperCase(), description });
const label = job('Label for review', 'pass', 'PR labels', 'pull_request_target');
// ci.yml skips its jobs on push for every branch but main: each PR head carries these.
const pushSkipped = [job('Checks', 'skipping', 'CI', 'push'), job('Player journeys', 'skipping', 'CI', 'push')];
const ciPassed = [job('Checks', 'pass'), job('Player journeys', 'pass'), label, ...pushSkipped];
const judgesWaiting = [
  status('Verdict', 'pending', 'Draft: mark the PR ready for review to start the judge'),
  status('real Coach', 'pending'),
  job('Gate', 'pending', 'Verdict', 'pull_request_target'),
  job('Judge', 'pending', 'Verdict', 'pull_request_target'),
];

describe('where CI stands', () => {
  it('is done and passed when CI passed, while the judges are still pending', () => {
    const p = progress([...ciPassed, ...judgesWaiting], required);
    expect(p).toMatchObject({ done: true, passed: true, missing: [] });
    expect(p.other.map((c) => c.name)).toEqual(['Verdict', 'real Coach', 'Gate', 'Judge']);
    expect(p.ci.some((c) => c.event === 'push')).toBe(false);
  });

  it('keeps waiting while a required check has only its skipped push copy, as after a push or with a merge conflict', () => {
    const p = progress([label, ...pushSkipped, ...judgesWaiting], required);
    expect(p).toMatchObject({ done: false, passed: false, missing: ['Checks', 'Player journeys'] });
    expect(progress([], required).done).toBe(false);
  });

  it('keeps waiting while any other CI job runs, and counts skipped jobs as finished', () => {
    expect(progress([...ciPassed, job('Package check', 'pending', 'Release')], required).done).toBe(false);
    expect(progress([...ciPassed, job('Publish to npm', 'skipping', 'Release')], required)).toMatchObject({ done: true, passed: true });
  });

  it('is done and failed as soon as a CI job fails or is cancelled', () => {
    expect(progress([job('Checks', 'fail'), job('Player journeys', 'pending')], required)).toMatchObject({ done: true, passed: false });
    expect(progress([...ciPassed, job('Package check', 'cancel', 'Release')], required)).toMatchObject({ done: true, passed: false });
  });

  it('never waits for a preview: one replaced in the queue shows as cancelled, and one may wait long', () => {
    expect(progress([...ciPassed, job('Preview', 'cancel', 'Preview', 'pull_request_target')], required)).toMatchObject({ done: true, passed: true });
    expect(progress([...ciPassed, job('Preview', 'pending', 'Preview', 'pull_request_target')], required)).toMatchObject({ done: true, passed: true });
  });

  it('counts a CI job that happens to share a judge status name as CI', () => {
    expect(progress([...ciPassed, job('Verdict', 'pending', 'Something else')], required).done).toBe(false);
  });
});

describe('waitForCi', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // A fake gh: `pr view` gives the next head (and mergeable), `pr checks` the next of the given answers.
  function fakeGh(answers: Check[][], heads: string[] = [A], mergeable = 'MERGEABLE', failures = 0) {
    let checks = 0;
    let views = 0;
    let failed = 0;
    return (args: string[]) => {
      if (failed++ < failures) throw Object.assign(new Error('HTTP 502'), { stderr: 'HTTP 502' });
      if (args[1] === 'view') return JSON.stringify({ headRefOid: heads[Math.min(views++, heads.length - 1)], headRefName: 'claude/x', mergeable });
      return JSON.stringify(answers[Math.min(checks++, answers.length - 1)]);
    };
  }
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), local: () => undefined };
  };
  const opts = { timeoutMs: 600_000, intervalMs: 30_000 };

  it('returns 0 once CI passes on a second look, never waiting for the Verdict', async () => {
    const r = await waitForCi('69', { ...opts, ...clock(), run: fakeGh([judgesWaiting, [...ciPassed, ...judgesWaiting]]) });
    expect(r.code).toBe(0);
    expect(r.text).toContain('CI passed');
    expect(r.text).toContain('(not waited for) Verdict: pending, Draft: mark the PR ready for review to start the judge');
    expect(r.text).not.toContain('Judge');
  });

  it('does not pass on a green look when a job appears just after it', async () => {
    const late = [...ciPassed, job('Package check', 'fail', 'Release')];
    const r = await waitForCi('69', { ...opts, ...clock(), run: fakeGh([ciPassed, late]) });
    expect(r.code).toBe(1);
    expect(r.text).toContain('failed: Release / Package check');
  });

  it('returns 1 when a CI job fails', async () => {
    const r = await waitForCi('69', { ...opts, ...clock(), run: fakeGh([[job('Checks', 'fail'), ...judgesWaiting]]) });
    expect(r.code).toBe(1);
    expect(r.text).toContain('failed: CI / Checks');
  });

  it('returns 1 at once when a merge conflict keeps CI from running', async () => {
    const r = await waitForCi('69', { ...opts, ...clock(), run: fakeGh([[label, ...pushSkipped]], [A], 'CONFLICTING') });
    expect(r.code).toBe(1);
    expect(r.text).toContain('merge conflict');
  });

  it('gives up with 3 when the time limit runs out', async () => {
    const r = await waitForCi('69', { ...opts, timeoutMs: 120_000, ...clock(), run: fakeGh([[job('Checks', 'pending'), ...judgesWaiting]]) });
    expect(r.code).toBe(3);
    expect(r.text).toContain("hasn't finished after 2 minutes");
  });

  it('stops with 3 when the PR gets another commit while waiting', async () => {
    const r = await waitForCi('69', { ...opts, ...clock(), run: fakeGh([[job('Checks', 'pending')]], [A, A, B]) });
    expect(r.code).toBe(3);
    expect(r.text).toContain('another commit (bbbbbbb)');
  });

  it('right after a push, waits for the pushed commit instead of reporting the one before it', async () => {
    // GitHub still shows the old head A, whose CI passed; the checkout is at B.
    const c = { ...clock(), local: () => B };
    const r = await waitForCi('69', { ...opts, ...c, run: fakeGh([ciPassed, ciPassed, [job('Checks', 'pending')], ciPassed], [A, A, B]) });
    expect(r.code).toBe(0);
    expect(r.text).toContain('PR #69 at bbbbbbb');
  });

  it('says so with 3 when the commit never reaches the PR', async () => {
    const r = await waitForCi('69', { ...opts, ...clock(), sha: 'cccccccc', run: fakeGh([ciPassed], [A]) });
    expect(r.code).toBe(3);
    expect(r.text).toContain("head is aaaaaaa, not ccccccc: push the commit, or pass --sha");
  });

  it('tries again after a GitHub error, and gives up after three in a row', async () => {
    const ok = await waitForCi('69', { ...opts, ...clock(), run: fakeGh([ciPassed], [A], 'MERGEABLE', 2) });
    expect(ok.code).toBe(0);
    await expect(waitForCi('69', { ...opts, ...clock(), run: fakeGh([ciPassed], [A], 'MERGEABLE', 3) })).rejects.toThrow('HTTP 502');
  });
});

describe('the hook that blocks waiting for every check', () => {
  const hook = new URL('../../.claude/hooks/no-watch-all-checks.ts', import.meta.url).pathname;
  const root = new URL('../../', import.meta.url).pathname;
  const settings = JSON.parse(readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8'));
  const hookCommand: string = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash').hooks[0].command;
  // The hook as Claude Code runs it: the settings command in a shell, the tool call on stdin.
  const runHook = (command: string, projectDir = root) =>
    spawnSync('sh', ['-c', hookCommand], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

  it('knows the commands that wait for every check', () => {
    for (const c of [
      'gh pr checks 69 --watch',
      'sleep 30; gh pr checks 69 --watch --interval 30 >/dev/null 2>&1',
      'gh pr checks --watch',
      'cd x && gh  pr checks 69 --required --watch',
      'gh -R inprealpha/OpenChessCoach pr checks 69 --watch',
      'gh --repo=inprealpha/OpenChessCoach pr checks 69 --watch',
      'gh pr checks 69 \\\n  --watch',
    ]) {
      expect(watchesAllChecks(c), c).toBe(true);
    }
    for (const c of [
      'gh pr checks 69',
      'gh pr checks 69 --json name,state',
      'npm run -s wait:ci -- 69',
      'gh run watch 123',
      'gh pr checks 69 | grep --watch',
      'echo gh pr checks; tail --watch',
      'git commit -m "Block gh pr checks --watch"',
      "git log --grep 'gh pr checks --watch'",
      'gh pr create --body "Never run `gh pr checks 69 --watch`."',
      "git commit -F - <<'EOF'\nBlock gh pr checks --watch\nEOF",
    ]) {
      expect(watchesAllChecks(c), c).toBe(false);
    }
  });

  it('blocks such a command with exit 2 and points to wait:ci, and lets others run', () => {
    const blocked = runHook('sleep 30; gh pr checks 69 --watch --interval 30');
    expect(blocked.status).toBe(2);
    expect(blocked.stderr.trim()).toBe(MESSAGE);
    expect(MESSAGE).toContain('npm run -s wait:ci -- <pr>');
    expect(runHook('gh pr checks 69').status).toBe(0);
    expect(runHook('git commit -m "Block gh pr checks --watch"').status).toBe(0);
    expect(spawnSync('node', [hook], { input: 'not json', encoding: 'utf8' }).status).toBe(0);
  });

  it('still blocks when the project folder is reached through a symlink with a space in its name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wait-ci-'));
    try {
      const link = join(dir, 'a project');
      symlinkSync(root, link);
      expect(runHook('gh pr checks 69 --watch', link).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets everything run in a checkout without the hook file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wait-ci-'));
    try {
      expect(runHook('gh pr checks 69 --watch', dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is wired into the repository settings, with the npm script it names', () => {
    expect(hookCommand).toContain('.claude/hooks/no-watch-all-checks.ts');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['wait:ci']).toBe('node scripts/wait-ci.ts');
  });
});
