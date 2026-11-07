---
name: sandbox
description: Set up a sandbox (Claude Code cloud, InstaBox, a Mac or any other machine) to work on OpenChessCoach, and run a preview of a branch that the owner can open on a phone. Use when preparing a new machine, when the owner wants to see or try a change (a preview link of a branch or PR), or when adding support for another sandbox provider.
---

# Sandboxes and previews

Two layers. Layer 1 is the same on every machine and lives in `scripts/sandbox/`. Layer 2 is one
small script per provider that starts a machine, runs layer 1 on it and gives it a link.

## Off by default; each owner turns it on outside the repository

The files here are neutral: nothing in them names anyone's provider, box or account, and previews
are off. Whoever runs the repository turns them on in places a fork or a clone doesn't copy:

| Where | What it holds |
| --- | --- |
| The repository's GitHub settings (Actions variables and secrets) | `PREVIEW_PROVIDER` (`instabox`), `PREVIEW_BOX` (the box's name, default `occ-preview`), `PREVIEW_CLAUDE_SECRET` (default `CLAUDE_CODE_OAUTH_TOKEN`), and the secrets `INSTABOX_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: the preview workflow reads them |
| The owner's Claude Code cloud environment (its setup script) | Running `prepare.sh`, and the owner's own instructions for their sessions, such as a `~/.claude/CLAUDE.md` |
| The owner's desktop | `INSTABOX_PREVIEW_BOX` and `telegram-notify`, for running the scripts by hand |

## When the owner wants to see a change

Ask for a preview when trying the change says more than screenshots: a screen, a flow, a Coach
reply. Push the branch and add a line `Preview: on` to the PR's description (or the `preview` label).
Optional lines: `Preview seed: NAME` when another seed shows the change better, and
`Preview coach: real` when the Coach is the change.

- Where the repository has previews set up, the owner gets the link by Telegram, usually within a few
  minutes, and the PR gets a comment saying what is running. Tell them it is on its way. Every push to
  the PR refreshes the preview; closing the PR takes it down.
- Where it doesn't, a comment on the PR says previews aren't set up: send before and after
  screenshots, desktop and phone (`scripts/before-after.ts`), instead.
- Never ask for, print or pass on the pairing code.

## Layer 1: any machine

- **Prepare:** `bash scripts/sandbox/prepare.sh` installs the dependencies and the Chromium build the
  repo's Playwright pins, builds the web app and downloads the Maia-3 model, for working on the app.
  It runs from any folder. `--strict` exits 1 when a step failed. A Linux machine that has never run a
  browser may also need `sudo npx playwright install-deps chromium`.
- **Preview:** `bash scripts/sandbox/preview.sh [--repo DIR] [--sandbox] [--seed NAME] [--port N]
  [--real-coach]` installs the checkout's packages, builds the web app, starts a verify-mode run on
  port 8790 and checks it with `coachctl doctor`. Its last line on stdout is JSON: `ok`, `runId`,
  `port`, `coach`, `commit`, `doctor`, and `pairPath` (`/#pair=<code>`) only when `ok` is true. A
  failed run is stopped, and the JSON then has only `error` and the failed doctor checks.
- **The bubble (`--sandbox`):** the branch's code (the install, the build, verify mode, doctor) runs
  inside a bubblewrap bubble, installed when missing. It sees the system's files read-only, the
  checkout, and a home folder and `/tmp` of its own (`~/.occ-preview-sandbox`). It doesn't see the
  user's home folder, the machine's temp folder (`/data/tmp`), its Secrets' placeholders
  (`/run/instabox/secrets`), the user's runtime folder (`/run/user`) or its other programs: it has its
  own process list, so it can't read other programs' environments. Docker's socket and other container
  engines' are covered up, and the bubble runs with none of the user's extra groups (on InstaBox the
  user is in `docker`, which works like root). Its environment is cleared, except the proxy's
  certificate settings, and `CLAUDE_CODE_OAUTH_TOKEN` with `--real-coach`. It needs sudo without a
  password, for one step: root gives the bubble its own process list with a fresh `/proc` (InstaBox
  boxes mount over a file in `/proc`, which stops a bubble without root doing that) and drops the
  user's extra groups. Then bwrap itself runs as the machine's user, in a user namespace, so a
  machine's AppArmor rules for bwrap (as on Ubuntu 24.04) apply as meant; everything inside has no
  capabilities, no way back to root and no way to make another namespace. Before the branch's code runs, the bubble checks all of this
  itself and the preview stops if anything is wrong (`preview.sh --check-bubble` runs only that check).
  The bubble stays open with the preview in it until `clean.sh` ends it, and with it everything the
  branch started.
- **What the bubble doesn't stop:** it shares the machine's network, since it serves the preview's
  port, so it can reach services listening on the machine's localhost. And it can read the system's
  world-readable files (`/etc`, other users' public folders). Keep nothing secret in those on a box
  that previews branches.
- **`--real-coach`:** verify mode's real Coach (`npm run verify -- --real-coach`), through
  `CLAUDE_CODE_OAUTH_TOKEN`. It spends real Claude usage. The preview fails unless doctor reports the
  Coach ready, which means Claude Code is found in the bubble and a token is there; whether the token
  works shows on the first question, since checking it would spend a call on every preview. A branch
  from before that option fails with a clear error rather than quietly using the fake Coach.
- **Clean:** `bash scripts/sandbox/clean.sh --sandbox [--repo DIR] [--deep] [--max-percent N]` ends
  the preview's bubble and any verify-mode run of the checkout started outside one, and deletes their
  run files, data and evidence, without running the branch's code. When the disk is still more than
  80% full (or with `--deep`), it also clears npm's caches, runs a `git gc` (which keeps the reflog,
  so stashes stay) and deletes `node_modules`. It exits 1 when the disk stays above the limit. It
  deletes evidence, so it refuses to run without `--sandbox`.
- A machine needs Linux or macOS, Node.js 22.18 or later, about 4 GB of memory, internet access for
  npm, GitHub and the Playwright and Lichess hosts, and, for previews, one port that a link can reach
  (and, for the bubble, Linux with bubblewrap).

## Rules

- **The pairing code is private.** `pairPath` and any link built from it go only to the owner: their
  terminal or Telegram. Never into a PR, a comment, a commit, a log you upload or a chat with anyone
  else (ADR 0001). In GitHub Actions, `instabox.sh` prints no link, and reports a failure only by its
  error; `scripts/test/sandbox.test.ts` checks this with a fake `instabox` CLI.
- **The fake Coach unless the Coach is the change.** Verify mode's fake Coach never calls Claude. A
  preview uses the real Coach only when the PR says `Preview coach: real`.
- **Previews leave the box as they found it.** They never remove or change a Secret or anything else
  the box holds for other work; a real-Coach preview adds the Claude Secret to the box's selection
  when it isn't selected yet, and it stays.
- **Working means doctor passes.**
- **Previews run only branches of the repository the workflow runs in,** never a PR from a fork.

## Layer 2: providers

### InstaBox

Needs the `instabox` CLI signed in (`npx instabox@latest`, or `INSTABOX_API_KEY` in CI).

```bash
bash scripts/sandbox/instabox.sh up [--ref BRANCH] [--seed NAME] [--box NAME] [--real-coach] [--notify]
bash scripts/sandbox/instabox.sh status [--box NAME]
bash scripts/sandbox/instabox.sh down [--box NAME] [--if-ref BRANCH] [--pause | --delete]
```

- `up` previews a branch as it is on GitHub (the current branch by default, so push first). It
  creates the box (`--box`, else `INSTABOX_PREVIEW_BOX`, else `occ-preview`) or wakes it, checks the
  branch out, runs `preview.sh --sandbox` there, publishes port 8790 and prints the link. `--notify`
  sends it with `telegram-notify`, else with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Its last line
  on stdout is JSON with `link`, which holds the pairing code; in GitHub Actions (`GITHUB_ACTIONS=true`)
  the link is never printed and the JSON has no `link`.
- `--real-coach` needs a Secret named `PREVIEW_CLAUDE_SECRET` (default `CLAUDE_CODE_OAUTH_TOKEN`) in
  the InstaBox account (`claude setup-token`, then `instabox secrets set CLAUDE_CODE_OAUTH_TOKEN --ai
  anthropic`); `up` selects it on the box when it isn't selected, and waits until the box has it.
- The scripts that run on the box are the caller's copies of `preview.sh` and `clean.sh`, copied to
  `~/.occ-preview-tools`, not the branch's: a branch can't change how its preview is checked or
  cleaned, and a branch from before these scripts still gets a preview.
- A lock on the box (`~/.occ-preview.lock`) keeps a preview and a take-down from overlapping.
- `down` ends the preview and cleans the box; `--if-ref BRANCH` does it only when the box is showing
  that branch, and then leaves the port published, with nothing behind it, for the next preview.
  Without `--if-ref` it also unpublishes the port. It leaves the box on, since the owner may use it for
  other work; `--pause` pauses it and `--delete` deletes it. `status` shows the branch the box is
  showing and how full its disk is.
- The free plan has one box in all, paused or not: previews share it with other work.
- A box pauses after 30 idle minutes, and opening the link wakes it. A box someone paused or stopped
  answers 503 until `up` or `instabox resume`.

### The preview workflow

`.github/workflows/preview.yml` runs only in a repository whose settings say
`PREVIEW_PROVIDER=instabox`, on the box `PREVIEW_BOX`, cloning that repository. A decide job
(`scripts/sandbox/preview-decide.sh`) reads each PR event: a PR that asks for a preview (the `preview`
label, or a whole `Preview: on` line outside HTML comments) gets `instabox.sh up --notify` when it
asks and on every push; closing it runs `down --if-ref`. A request where previews aren't set up gets a
comment saying so. Only the preview job joins the box's queue, so a run that needs no preview never
replaces a waiting one. The workflow keeps one comment on the PR (`scripts/sandbox/pr-comment.sh`)
with the commit, the seed, the Coach and whether doctor passed, never the link. Without the three
secrets it skips with a notice. It runs the base branch's scripts (`pull_request_target`) and never
previews a fork. To preview any branch by hand:
`gh workflow run preview.yml -f ref=BRANCH [-f seed=empty] [-f coach=real]`.

### Claude Code cloud

Layer 1 only: the environment's setup setting runs `prepare.sh`, and the runtime sets
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. The environment needs the hosts `cdn.playwright.dev`,
`playwright.download.prss.microsoft.com` and `tablebase.lichess.ovh` allowed. A cloud session can't
give the owner a link itself: it asks for a preview through the PR, as above.

### Adding a provider

A provider's script answers five questions, as `instabox.sh` does: how it signs in, how it starts a
machine, how it runs a command on it, how a port gets a link, and how the machine is deleted. Its
`up` runs `preview.sh --sandbox` and nothing else on the machine, so every provider previews the same
way, in the same bubble.
