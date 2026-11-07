---
name: sandbox
description: Set up a sandbox (Claude Code cloud, InstaBox, a Mac or any other machine) to work on OpenChessCoach, and run a preview of a branch that the owner can open on a phone. Use when preparing a new machine, when asked for a preview link of a branch or PR, or when adding support for another sandbox provider.
---

# Sandboxes and previews

Two layers. Layer 1 is the same on every machine and lives in `scripts/sandbox/`. Layer 2 is one
small script per provider that starts a machine, runs layer 1 on it and gives it a link.

## Layer 1: any machine

- **Prepare:** `bash scripts/sandbox/prepare.sh` installs the dependencies and the Chromium build the
  repo's Playwright pins, builds the web app and downloads the Maia-3 model. It runs from any folder.
  `--strict` exits 1 when a step failed. A Linux machine that has never run a browser may also need
  `sudo npx playwright install-deps chromium`.
- **Preview:** `bash scripts/sandbox/preview.sh [--seed NAME] [--port N]` prepares the machine, stops
  earlier verify-mode runs, starts a fresh one on port 8790 and checks it with `coachctl doctor`. Its
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
- **Previews run only branches of this repository** (they clone from GitHub), never code from a fork.

## Layer 2: providers

### InstaBox

Needs the `instabox` CLI signed in (`npx instabox@latest`, or `INSTABOX_API_KEY` in CI).

```bash
bash scripts/sandbox/instabox.sh up [--ref BRANCH] [--seed NAME] [--box NAME] [--notify]
bash scripts/sandbox/instabox.sh status [--box NAME]
bash scripts/sandbox/instabox.sh down [--box NAME] [--delete]
```

- `up` previews a branch as it is on GitHub (the current branch by default, so push first). It
  creates the box `occ-preview` or wakes it, checks the branch out, runs `preview.sh`, publishes port
  8790 and prints the link. `--notify` sends the link with `telegram-notify`. Its last line on stdout
  is JSON with `link`, which holds the pairing code.
- Running `up` again on the same box replaces the preview and keeps the same link host.
- `down` unpublishes the port and pauses the box; `--delete` deletes it.
- The free plan has one box in all, paused or not. Reuse it with `--box`, or delete it first.
- A box pauses after 30 idle minutes, and opening the link wakes it. A paused or stopped box you
  paused yourself answers 503 until `up` or `instabox resume`.
- Timing on a fresh box (4 CPUs): about 20 seconds for `prepare.sh`, under 30 for the whole `up`.

### Claude Code cloud

Layer 1 only: the environment's setup setting runs `prepare.sh`, and the runtime sets
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. The environment needs the hosts `cdn.playwright.dev`,
`playwright.download.prss.microsoft.com` and `tablebase.lichess.ovh` allowed. A cloud session can't
give the owner a link: it takes before and after screenshots instead.

### Adding a provider

A provider's script answers five questions, as `instabox.sh` does: how it signs in, how it starts a
machine, how it runs a command on it, how a port gets a link, and how the machine is deleted. Its
`up` runs `preview.sh` and nothing else on the machine, so every provider previews the same way.
