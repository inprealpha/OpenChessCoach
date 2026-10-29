# The Verdict runs once per finished PR, in a GitHub Action

ADR 0006 says the agent that judges a PR is never the one that wrote it, and left open where that judge runs. It runs as Claude Code in a GitHub Actions job, `.github/workflows/verdict.yml`: a fresh session reads the diff and the issue it closes, drives a verify-mode copy of the app with `coachctl` as the verify skill says, and posts `PASS`, `PASS+NOTES` or `FAIL` as the `Verdict` status on the PR's head commit, with its evidence in a PR comment and the run's artifacts. `main` requires that status.

A PR gets many pushes while its author works, and a judge on every push would spend the owner's Claude limits on commits that the next push replaces. So the judge runs once per finished PR:

- **PRs open as drafts**, and a draft never starts the judge. The author reviews, verifies and fixes for as long as it needs.
- **Marking a PR ready for review starts it**, and only after CI (Checks and Player journeys) passes on that commit: a red PR has nothing to judge.
- **A push voids the verdict but starts no run.** The new commit gets a pending `Verdict` from the cheap labelling workflow, so it can't merge, and a new run starts only when someone with write access comments `/verdict` or runs the workflow by hand.
- **Docs, tests and process files need no judge.** A PR that changes only the files in `.github/no-verdict-paths.txt` passes at once. Any other file needs a verdict, so a new kind of file is judged until someone lists it.
- **Runs are limited**: one at a time per PR, at most 3 judge runs per PR and 10 per day (counted by their Verdict comments), and the owner gets a Telegram notice when one starts.

## Considered options

- **Claude Code's scheduled tasks with a GitHub trigger** run on Anthropic's machines, but they are a research preview, the docs don't say they can post a status that blocks a merge, and the app's headless browser may not download behind their default network rules.
- **Claude Code Review** posts a check that never fails, so it can't block a merge.
- **A GitHub Action** runs on GitHub's runners, free for a public repository, where CI already runs the app and its browser. Our own workflow decides when it runs and posts the status, so the trigger rules above are ours to set. This one was chosen.

## Consequences

- The job runs this workflow and its scripts as they are on `main` (`pull_request_target`, `issue_comment`), so a PR can't change its own judge. Because those events carry secrets, it refuses PRs from forks; only branches of this repository, which only people with write access can push, get their code run. Every step that runs the PR's code (its install scripts, its build, its real-Coach check, the judge) gets no GitHub token and no git credentials, so a PR can't post its own verdict: the trusted steps hand the judge the PR's details as files and post what it wrote.
- Only the `Verdict` status that GitHub Actions posts counts for branch protection. Agents use the owner's own GitHub account, so a status they post themselves doesn't satisfy it.
- It authenticates with a token from `claude setup-token` (the `CLAUDE_CODE_OAUTH_TOKEN` secret), so runs count against the owner's Claude subscription, shared with their own sessions.
- That token also runs the real Coach: tested on 2026-10-29 with no desktop login, the real-Coach check passed all 14 calls on Haiku. So for a PR that touches the Coach, the job runs the real-Coach check first and posts the `real Coach` status, once more if a Think deeper timeout stopped it. The desktop check (`.claude/skills/real-coach-check/`) stays as the fallback.
- The judge reads the PR's own text, so a PR could try to talk it into a pass. The owner still merges by hand (ADR 0006), and every verdict links the evidence behind it.
- When the verdicts have proven reliable, auto-merge for PRs that touch nothing protected can require this status.
