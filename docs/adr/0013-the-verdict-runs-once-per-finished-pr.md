# The Verdict runs once per finished PR, in a GitHub Action

ADR 0006 says the agent that judges a PR is never the one that wrote it, and left open where that judge runs. It runs as Claude Code in a GitHub Actions job, `.github/workflows/verdict.yml`: a fresh session reads the diff and the issue it closes, drives a verify-mode copy of the app with `coachctl` as the verify skill says, and posts `PASS`, `PASS+NOTES` or `FAIL` as the `Verdict` status on the PR's head commit, with its evidence in a PR comment and the run's artifacts. `main` requires that status.

A PR gets many pushes while its author works, and a judge on every push would spend the owner's Claude limits on commits that the next push replaces. So the judge runs once per finished PR:

- **PRs open as drafts**, and a draft never starts the judge. The author reviews, verifies and fixes for as long as it needs.
- **Marking a PR ready for review starts it**, and only after CI (Checks and Player journeys) passes on that commit: a red PR has nothing to judge.
- **A push voids the verdict but starts no run.** The new commit gets a pending `Verdict` from the cheap labelling workflow, so it can't merge, and a new run starts only when someone with write access comments `/verdict` or runs the workflow by hand.
- **Docs, tests and process files need no judge.** A PR that changes only the files in `.github/no-verdict-paths.txt` passes at once. Any other file needs a verdict, so a new kind of file is judged until someone lists it.
- **Runs are limited**: one at a time per commit (a second trigger while one is judging does nothing), at most 3 judge runs per PR and 10 per day (counted by their Verdict comments), at most $5 per run at API prices (`--max-budget-usd`), and the owner gets a Telegram notice when the judge starts.
- **Nothing is spent on a PR that can't be judged.** A PR with merge conflicts gets no CI, so the gate says so at once instead of waiting. A PR that gets a new commit, closes or goes back to draft while the gate waits for CI is not judged. A failed real-Coach check is a `FAIL` already, so Opus doesn't run.

## Considered options

- **Claude Code's scheduled tasks with a GitHub trigger** run on Anthropic's machines, but they are a research preview, the docs don't say they can post a status that blocks a merge, and the app's headless browser may not download behind their default network rules.
- **Claude Code Review** posts a check that never fails, so it can't block a merge.
- **A GitHub Action** runs on GitHub's runners, free for a public repository, where CI already runs the app and its browser. Our own workflow decides when it runs and posts the status, so the trigger rules above are ours to set. This one was chosen.

## Consequences

- The workflow runs as it is on `main` (`pull_request_target`, `issue_comment`, and a manual run only from `main`), so a PR can't change its own judge. Because those events carry secrets, it refuses PRs from forks; only branches of this repository, which only people with write access can push, get their code run. It is three jobs: the gate (decides, enforces the limits, waits for CI), the judge (runs the PR's code and Claude, with a read-only GitHub token) and the post job (reads what the judge wrote, as data, and posts it). So the PR's code never holds a token that can post a status.
- This keeps an agent from passing its own PR by mistake, or by editing a file in the PR. It can't stop an agent that sets out to cheat. Agents work under the owner's own GitHub account, which can push to `main` directly, add a workflow on a branch that posts any status as GitHub Actions and reads the repository's secrets, or skip branch protection as an admin. The PR's code also runs on the judge's machine, so it could forge the judge's files. A real boundary would need agents on a GitHub identity of their own, with the Verdict posted by a GitHub App and its token in an environment only `main` can use. Until then the owner merges by hand (ADR 0006), and every verdict links the evidence behind it.
- It authenticates with a token from `claude setup-token` (the `CLAUDE_CODE_OAUTH_TOKEN` secret), so runs count against the owner's Claude subscription, shared with their own sessions.
- That token also runs the real Coach: tested on 2026-10-29 with no desktop login, the real-Coach check passed all 14 calls on Haiku. So for a PR that touches the Coach, the job runs the real-Coach check first and posts the `real Coach` status, once more if a Think deeper timeout stopped it. A PR that changes `scripts/real-coach-check.ts` itself is left to the desktop, since the job runs the PR's copy. The desktop check (`.claude/skills/real-coach-check/`) stays as the fallback.
- The judge reads the PR's own text, so a PR could try to talk it into a pass: another reason the owner still merges by hand.
- Artifacts and comments on a public repository are public, so the judge job deletes any file that contains the Claude token before uploading.
- When the verdicts have proven reliable, auto-merge for PRs that touch nothing protected can require this status.
