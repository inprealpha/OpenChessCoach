---
name: sandbox
description: Set up a sandbox (Claude Code cloud, InstaBox, a Mac or any other machine) to work on OpenChessCoach, and run a preview of a branch that the owner can open on a phone. Use when preparing a new machine, when asked for a preview link of a branch or PR, or when adding support for another sandbox provider.
---

# Sandboxes and previews

Two layers. Layer 1 is the same on every machine and lives in `scripts/sandbox/`. Layer 2 is one
small script per provider that starts a machine, runs layer 1 on it and gives it a link.

## Off by default; each owner turns it on outside the repository

The files here are neutral: nothing in them names anyone's provider, box or account, and previews
are off. Whoever runs the repository turns them on in places a fork or a clone doesn't copy:

| Where | What it holds |
| --- | --- |
| The repository's GitHub settings (Actions variables and secrets) | `PREVIEW_PROVIDER` (`instabox`), `PREVIEW_BOX` (the box's name, default `occ-preview`), and the provider's and Telegram's secrets: the preview workflow reads them |
| The owner's Claude Code cloud environment (its setup script) | Running `prepare.sh`, and the owner's own instructions for their sessions, such as a `~/.claude/CLAUDE.md` saying they want previews |
| The owner's desktop | `INSTABOX_PREVIEW_BOX` and `telegram-notify`, for running the scripts by hand |

A fork or a clone without these gets the plain behaviour: no previews, and agents send screenshots.

## When the owner asks to see a change

- **If the owner's own instructions say previews are set up for them** (their `~/.claude/CLAUDE.md`
  or what they tell you): push your branch and open a draft PR with a line `Preview: on` in its
  description (and `Preview seed: NAME` if another seed shows the change better). The preview
  workflow sends them the link by Telegram, usually within a few minutes. Tell them it is on its
  way. Never ask for, print or forward the pairing code.
- **Otherwise:** take before and after screenshots, desktop and phone (`scripts/before-after.ts`),
  and show them those. Don't open a PR just to ask for a preview nobody has set up.

## Layer 1: any machine

- **Prepare:** `bash scripts/sandbox/prepare.sh` installs the dependencies and the Chromium build the
  repo's Playwright pins, builds the web app and downloads the Maia-3 model. It runs from any folder.
  `--strict` exits 1 when a step failed. A Linux machine that has never run a browser may also need
  `sudo npx playwright install-deps chromium`.
- **Clean:** `bash scripts/sandbox/clean.sh [--deep] [--max-percent N]` stops every verify-mode run
  and deletes their data, run files and evidence. When the disk is still more than 80% full (or with
  `--deep`), it also clears npm's cache, unused git objects and `node_modules`. It exits 1 when the disk
  stays above the limit. It deletes evidence, so run it only on a sandbox.
- **Preview:** `bash scripts/sandbox/preview.sh [--seed NAME] [--port N]` cleans up with `clean.sh`,
  prepares the machine, starts a fresh verify-mode run on port 8790 and checks it with `coachctl doctor`. Its
  last line on stdout is JSON: `ok`, `runId`, `port`, `commit`, `doctor` and `pairPath`
  (`/#pair=<code>`). Seeds are verify mode's: `default`, `empty` (the first-run screen), `many-games`,
  `no-phone`.
- A machine needs Linux or macOS, Node.js 22.18 or later, about 4 GB of memory, internet access for
  npm, GitHub and the Playwright and Lichess hosts, and, for previews, one port that a link can reach.

## Rules

- **The pairing code is private.** `pairPath` and any link built from it go only to the owner: their
  terminal or `telegram-notify`. Never into a PR, a comment, a commit, a log you upload or a chat
  with anyone else (ADR 0001).
- **Previews use the fake Coach and fake data.** Verify mode never calls Claude. A preview box gets
  no Secrets: `instabox.sh` clears them every time. Don't log Claude in on a sandbox; when an agent in
  a sandbox needs Claude, it signs in through the provider's secret store (an InstaBox Secret for
  `CLAUDE_CODE_OAUTH_TOKEN`, sent only to `api.anthropic.com`), never with `claude` login, whose files
  end up in snapshots.
- **Working means doctor passes.** `preview.sh` reports `ok: false` when any doctor check fails, with
  the failed checks' names.
- **Previews run only branches of the repository the workflow runs in** (they clone from GitHub),
  never a PR from a fork.

## Layer 2: providers

### InstaBox

Needs the `instabox` CLI signed in (`npx instabox@latest`, or `INSTABOX_API_KEY` in CI).

```bash
bash scripts/sandbox/instabox.sh up [--ref BRANCH] [--seed NAME] [--box NAME] [--notify]
bash scripts/sandbox/instabox.sh status [--box NAME]
bash scripts/sandbox/instabox.sh down [--box NAME] [--delete]
```

- `up` previews a branch as it is on GitHub (the current branch by default, so push first). It
  creates the box (`--box`, else `INSTABOX_PREVIEW_BOX`, else `occ-preview`) or wakes it, checks the branch out, runs `preview.sh`, publishes port
  8790 and prints the link. `--notify` sends the link with `telegram-notify`. Its last line on stdout
  is JSON with `link`, which holds the pairing code.
- Running `up` again on the same box replaces the preview and keeps the same link host.
- `down` stops the preview, cleans the box and unpublishes the port; `--if-ref BRANCH` does it only
  when the box is showing that branch. It leaves the box on, since the owner may use it for other
  work; `--pause` pauses it and `--delete` deletes it. `status` shows the branch the box is showing
  and how full its disk is.
- `up` removes any Secrets selected on the box and says which: a preview runs PR code, which must
  never reach the owner's credentials. Select them again afterwards when the box needs them.
- `--notify` uses `telegram-notify` when it is installed, else `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID`. In GitHub Actions (`GITHUB_ACTIONS=true`) the link is never printed, and the
  JSON line has no `link`: the logs are public.
- The free plan has one box in all, paused or not. Reuse it with `--box`, or delete it first.
- A box pauses after 30 idle minutes, and opening the link wakes it. A paused or stopped box you
  paused yourself answers 503 until `up` or `instabox resume`.
- Timing on a fresh box (4 CPUs): about 20 seconds for `prepare.sh`, under 30 for the whole `up`.

### The preview workflow

`.github/workflows/preview.yml` runs only in a repository whose settings say
`PREVIEW_PROVIDER=instabox`, on the box `PREVIEW_BOX`, cloning that repository. It runs
`instabox.sh up --notify` for every ready PR, every draft with the `preview` label or a line
`Preview: on` in its description, and every push to those; `down --if-ref` when the PR closes. A line
`Preview seed: empty` in the PR description picks the seed. It keeps one comment on the PR with the
commit, the seed and whether doctor passed, never the link. It needs three repository secrets:
`INSTABOX_API_KEY` (an InstaBox API key with the machine scopes), `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`; without them it skips with a notice. Another provider would add its own value
of `PREVIEW_PROVIDER`, with its adapter script and secrets. It runs the base branch's scripts
(`pull_request_target`) and never previews a fork. To preview any branch by hand:
`gh workflow run preview.yml -f ref=BRANCH [-f seed=empty]`.

### Claude Code cloud

Layer 1 only: the environment's setup setting runs `prepare.sh`, and the runtime sets
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. The environment needs the hosts `cdn.playwright.dev`,
`playwright.download.prss.microsoft.com` and `tablebase.lichess.ovh` allowed. A cloud session can't
give the owner a link: it takes before and after screenshots instead.

### Adding a provider

A provider's script answers five questions, as `instabox.sh` does: how it signs in, how it starts a
machine, how it runs a command on it, how a port gets a link, and how the machine is deleted. Its
`up` runs `preview.sh` and nothing else on the machine, so every provider previews the same way.
