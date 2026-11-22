---
name: real-coach-check
description: Check a PR that touches the Coach against the real Coach and post the "real Coach" status on its head commit. The Verdict job tries it first in GitHub Actions (optional in branch protection); when GitHub couldn't run it, run and post it locally from any machine with OpenCode, Claude Code, Codex, or Pi available.
---

# Real-Coach check

CI uses the fake Coach, so a PR that touches the Coach (any path in `.github/coach-paths.txt`) gets
the `touches-coach` label and a `real Coach` status. The Verdict job (`.github/workflows/verdict.yml`,
ADR 0013) tries the real-Coach check first in GitHub Actions (walking `CI_PROVIDER_ORDER`, including
free Zero-Data-Retention OpenCode models when no subscription secret is saved). Because GitHub-hosted
runners share egress IPs, `real Coach` is optional in GitHub branch protection — when GitHub can't
run it, agents are reminded to run and post it locally from their own machine using whatever provider
is available (**OpenCode**, **Claude Code**, **Codex**, or **Pi**).

Each run makes 15 small Coach calls; on Claude it uses the latest Haiku (`haiku` alias), and on
unauthenticated free OpenCode it uses only the ZDR allowlist (`opencode/deepseek-v4.1-flash-free`,
`opencode/hy4-flash-free`, `opencode/longcat-2.5-free`).

## Steps

1. Check out the PR's head commit with a clean working tree:

   ```bash
   gh pr checkout <number>
   git status --porcelain        # must print nothing
   npm ci
   ```

2. Run the check with `--provider auto` (or pick a specific provider: `opencode`, `claude`, `codex`,
   or `pi`) and post the verdict on the head commit:

   ```bash
   node scripts/real-coach-check.ts --provider auto --post
   ```

   It starts a verify-mode instance with the real Coach in place of the fake one, makes one call of
   every Coach job (Why Question, Live Coaching, Hint, Lesson turn, and a Review of the seeded game:
   its overview and each key moment) through the same protocol the web app uses: each request
   carries only the position and the moves, and the instance's own Engine works out the facts
   (ADR 0007). It checks structure only:

   - every move or arrow a reply shows is legal and came from the Engine; a Review's overview
     names only the game moves its brief lists;
   - every piece move named in the text appears in the brief (the Engine's output, the game or the
     Lesson notes), and a Hint names no move at all;
   - a Lesson turn on a move that isn't the Lesson's (the Forks Lesson's first decision) neither
     names nor shows the Lesson's move, which its brief keeps back while the Player may try again;
   - each reply stays within its word budget; up to 25% over is a warning, more fails;
   - no reply uses a term `CONTEXT.md` says to avoid; one that does is a warning, not a failure
     (the wording is the model's, and the Player has already read the streamed reply);
   - no reply breaks the Coach's role: "AI", "assistant" or "user" (as in "As an AI assistant,
     I can't…") fails.

   It prints `{ ok, sha, calls: [{ job, words, maxWords, problems, warnings }], description }` and
   exits 0 on pass, 1 on fail, 2 when it couldn't run. On a pass with warnings, `description` (the
   posted status) counts them and quotes the first. `--post` sets the `real Coach` commit status to
   success or failure through `gh` and refuses when the working tree has changes, so the verdict
   always matches the commit it is posted on.

3. Comment on the PR with the JSON verdict (trimmed to the calls with problems or warnings), so
   the owner can see what was checked.

## Notes

- Any new push to the PR makes a new head commit with a pending status, so run the check again.
- A failure is about structure, never wording: fix the prompt, the brief or the guard, not the check.
- To test the script itself without spending limits: `node scripts/real-coach-check.ts --fake`
  (CI runs this). A fake-Coach verdict is never posted.
