---
name: real-coach-check
description: Check a PR that touches the Coach against the real Coach on the owner's desktop and post the "real Coach" status on its head commit. Use when a PR has the touches-coach label, from a Claude Code session on the owner's desktop where Claude Code is logged in.
---

# Real-Coach check

CI uses the fake Coach, so a PR that touches the Coach (any path in `.github/coach-paths.txt`) gets
the `touches-coach` label and a pending `real Coach` status. It can't merge until this check passes
on its exact head commit. It runs here, on the owner's desktop, because the real Coach uses the
owner's Claude Code login (ADR 0001), which cloud CI doesn't have. Each run makes about eight
small Coach calls on the owner's Claude subscription, all on the latest Haiku (the `haiku` alias),
whatever model each job uses in the app. The owner's rule: tests run on the latest Haiku.

## Steps

1. Check out the PR's head commit with a clean working tree:

   ```bash
   gh pr checkout <number>
   git status --porcelain        # must print nothing
   npm ci
   ```

2. Check that Claude Code is logged in: `claude --version` works and the owner has run `claude`
   at least once. The script refuses to start otherwise.

3. Run the check and read the verdict:

   ```bash
   node scripts/real-coach-check.ts
   ```

   It starts a verify-mode instance with the real Coach in place of the fake one, makes one call of
   every Coach job (Why Question, Live Coaching, Hint, Lesson turn, and each Review key moment of
   the seeded game) through the same protocol the web app uses: each request carries only the
   position and the moves, and the instance's own Engine works out the facts (ADR 0007). It checks
   structure only:

   - every move or arrow a reply shows is legal and came from the Engine;
   - every piece move named in the text appears in the brief (the Engine's output, the game or the
     Lesson notes), and a Hint names no move at all;
   - each reply stays within its word budget; up to 25% over is a warning, more fails;
   - no reply uses a term `CONTEXT.md` says to avoid; one that does is a warning, not a failure
     (the wording is the model's, and the Player has already read the streamed reply);
   - no reply breaks the Coach's role: "AI", "assistant" or "user" (as in "As an AI assistant,
     I can't…") fails.

   It prints `{ ok, sha, calls: [{ job, words, maxWords, problems, warnings }], description }` and
   exits 0 on pass, 1 on fail, 2 when it couldn't run. On a pass with warnings, `description` (the
   posted status) counts them and quotes the first.

4. Post the verdict on the head commit:

   ```bash
   node scripts/real-coach-check.ts --post
   ```

   This sets the `real Coach` commit status to success or failure through `gh`. It refuses when the
   working tree has changes, so the verdict always matches the commit it is posted on.

5. Comment on the PR with the JSON verdict (trimmed to the calls with problems or warnings), so
   the owner can see what was checked.

## Notes

- Any new push to the PR makes a new head commit with a pending status, so run the check again.
- A failure is about structure, never wording: fix the prompt, the brief or the guard, not the check.
- To test the script itself without spending limits: `node scripts/real-coach-check.ts --fake`
  (CI runs this). A fake-Coach verdict is never posted.
