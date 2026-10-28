---
name: verify
description: Prove a change works in the running OpenChessCoach before calling it done. Launches a disposable verify-mode copy of the app, checks it is healthy, drives the feature you changed, captures evidence for the PR and cleans up. Use before opening or updating any PR.
---

# Verify a change in the running app

A PR merges on evidence from the running app, not on a claim that it is done (ADR 0006). This skill
gets that evidence. You need no prior knowledge of the app: follow the five sections in order.

Words: use the terms in `CONTEXT.md` (Player, Coach, Engine, Move Grade, Lesson, Review, Puzzle,
Hint, Engine Game, Live Coaching, Why Question, Imported Game, Player Profile).

## Checks: once per commit

Every step you take re-reads the whole conversation, so running a suite again costs far more than
its runtime. Run each check once per commit:

- **While working:** only what you touched: `npx vitest run <test file>`,
  `npx playwright test e2e/journeys/<file>`, and `npm run typecheck`.
- **Once, before pushing:** the full gate, then let CI run it again on the PR:

  ```bash
  npm run typecheck && npm run lint && npm test && npm run build -w @chess-coach/web && npm run test:journeys
  ```

- **Not again** after a change to docs or comments only, or on a commit a subagent already ran the
  gate on.
- **Lesson data:** `node data-prep/engine-check.ts <ids you changed>`; `npm test` already checks
  every Lesson at verify mode's depth.
- **This skill's run and evidence:** once per PR, on the final code, not on every fix round.
- **Keep output short:** the default reporters print only failures and a summary. Don't add
  `--reporter=verbose` or paste whole logs into the conversation; read the failure you need.

## 1. Launch

Build the web app once per change to it, then start a disposable instance:

```bash
npm run build -w @chess-coach/web
npm run verify                    # or: npm run verify -- --seed empty   (a fresh install: first-run screen)
```

`npm run verify` prints JSON only once a device has paired over the WebSocket, so the instance is
usable when the command returns:

```json
{ "ok": true, "runId": "run-20261012-185409-t982", "url": "http://127.0.0.1:45189",
  "pairUrl": "http://127.0.0.1:45189/#pair=6PMAU8F7S8CC", "code": "6PMAU8F7S8CC", "token": "…",
  "pid": 3671, "dataDir": "/tmp/chess-coach-run-…", "evidenceDir": "…/evidence/run-20261012-185409-t982",
  "runFile": "…/.verify/runs/run-20261012-185409-t982.json", "next": "npm run coachctl -- doctor" }
```

What verify mode gives you:

- **A fake Coach** that answers every Coach job instantly from templates, records every brief it
  receives (`coachctl db get coach_calls`) and can be scripted (`coachctl coach script`).
- **The Engine at a fixed depth** (depth 10, 5 lines, one thread), so the same position always gets
  the same evaluation and Move Grades in the browser, on the desktop's Engine (which grades
  Reviews and works out every Coach brief's facts, ADR 0007) and in coachctl alike.
- **A fake clock** (`coachctl clock --set` / `--advance`).
- **A fresh data folder** in the system temp folder, seeded: `default` is a Player who finished
  first run (level casual, Goals set, a phone paired) with one Imported Game (an Italian Game, game
  id 1, the Player as White); `empty` is a fresh install; `many-games` is `default` plus 60 newer
  games, more than one page of the game list; `no-phone` is `default` with no phone paired, so the
  main menu asks for one.
- **A free port**, never the owner's 8737, so several runs and the owner's own app coexist.
- **Recorded sites**: username imports answer from `packages/backend/recordings/sites.json`
  (Lichess `CoachVerify`, chess.com `coachverify`; `NoSuchPlayer` is a 404, `BusyPlayer` a 429).
- **A fake tunnel**: away-from-home access returns `https://verify-mode.trycloudflare.com`.

Every later command finds the newest running instance by itself. With several runs, pass
`--run <runId>` to each command.

## 2. Doctor

```bash
npm run -s coachctl -- doctor
```

Read-only. Prints `{ "healthy": true|false, "checks": [...] }` and exits 1 when unhealthy. Each
failing check has a `fix` that says what to run. Do not drive an unhealthy instance: its results
mean nothing. The checks: the process is up, the port belongs to this run, coachctl and the
instance come from the same build, verify mode is on, the web app is served, a connection without
a token is refused, a paired device connects, and the Engine is at the fixed depth.

## 3. Drive

Open the feature map, `features/index.md`, find every feature your change touches and follow its
file: how a Player reaches it, how to drive it and the end state that proves it works. "The page
loaded" is never proof; a database row, a Move Grade, a list of key moments is.

Two ways to drive, both against the same instance:

- **coachctl**, for the backend and the protocol. JSON output, `--help` on every command:

  ```bash
  C="npm run -s coachctl --"
  $C play --moves "e4 Nf3 Bc4" --resign        # an Engine Game; prints each Move Grade
  $C import-pgn --file game.pgn --side white   # an Imported Game
  $C review --game 1                           # graded on the desktop; prints positionsGraded, key moments
  $C ask-why --fen "<fen>" --move Nf3          # a Why Question
  $C db get games --where source=pgn           # read any table back
  $C coach script --reply '{"text":"…","moves":["a2a4"]}'   # the fake Coach's next reply
  ```

- **The browser**, for what a Player sees. Open `pairUrl` to pair the browser, then drive by
  accessible name, never by screen position: every square is a button named like `e2, white pawn`
  or `e4, empty`; the move list is the list `Moves`; the Coach is the region `Coach`. Playwright
  journeys in `e2e/journeys/` show every feature driven this way, through the fixture in
  `e2e/fixtures/app.ts`, which starts its own instance per test.

  ```bash
  $C screenshot --route "#/review/1" --wait 2000    # saved to the run's evidence folder
  $C snapshot --route "#/games"                     # the accessibility tree, as YAML
  ```

If your change adds or changes a Player-facing feature, add or update its journey in
`e2e/journeys/` and its file in `features/`. A journey the seed data can't satisfy should fail,
not be weakened: extend the seed in `packages/backend/src/verify/seed.ts` instead.

## 4. Evidence

Everything goes in the run's evidence folder, `evidence/<runId>/`, which cleanup keeps. For the PR
description's **Evidence** section, collect:

- the commands you ran and their JSON output (trim it to what proves the point);
- screenshots or snapshots of the end state, from `coachctl screenshot` / `snapshot`;
- database readback for every side effect (`coachctl db get <table>`);
- the journeys you added or ran, with their result (`npx playwright test e2e/journeys/<file>`).

A PR whose Evidence section is empty gets the `no-evidence` label. Copy the ticket's "Done means"
checks into the PR and tick each one you proved.

### Before and after screenshots, inline in the PR

A PR that changes anything a Player sees shows it in the PR itself: for each changed screen, a
heading and one picture with the before on the left and the after on the right. The owner reviews
on GitHub, so a link to a folder or a page doesn't count.

1. **After:** on your branch, screenshot each changed screen at desktop and phone sizes:
   `coachctl screenshot --route "#/review/1" --width 1280 --height 800`, then `--width 390 --height 844`.
   Where a screen needs moves or clicks first, drive it with Playwright as the journeys do.
2. **Before:** the same screens, seed, moves and sizes on the PR's base branch, from a second
   worktree (`git worktree add --detach <dir> origin/<base>`, then `npm ci`, the web build and
   `npm run verify` there).
3. **Combine:** `node scripts/before-after.ts <before.png> <after.png> <out.png>` puts them side by
   side, labelled Before and After. For a new screen pass `-` as the before.
4. **Upload:** GitHub only shows images it can load, so push the combined PNGs to an orphan branch
   named `pr-<number>-evidence` (the owner allows this one push outside your PR branch). In a
   scratch worktree: `git checkout --orphan pr-<number>-evidence`, `git rm -rfq .`, copy the PNGs,
   commit, `git push -u origin pr-<number>-evidence`. That branch is never merged.
5. **Embed:** in the Evidence section, per screen a `###` heading naming the screen, the state and
   the ticket, then the desktop picture at full width, linked by the evidence commit's sha so it
   never moves: `![Board after 1. e4](https://github.com/<owner>/<repo>/raw/<sha>/board-e4-desktop.png)`.
   Put the phone pictures in one `<details>` block after the desktop ones.

If you touched a path in `.github/coach-paths.txt`, the fake Coach is not enough: the PR also needs
the real-Coach check from the owner's desktop (`.claude/skills/real-coach-check/SKILL.md`). Say so
in the PR.

## 5. Cleanup

```bash
npm run -s coachctl -- cleanup --dry-run     # what would happen
npm run -s coachctl -- cleanup               # every verify-mode run; or --run <runId> for one
```

Cleanup stops only processes whose command line names the run, so it never touches the owner's
own app, and deletes only the run's temporary data folder. The evidence folder stays. After
cleanup, `coachctl doctor --run <runId>` reports the run as not running.

## When something goes wrong

- `npm run verify` says the web app is not built: `npm run build -w @chess-coach/web`.
- Doctor's `version` check fails: rebuild and start a fresh run.
- Doctor's `port-owner` check fails: another process took the port; start a fresh run.
- The run's log is `.verify/runs/<runId>.log`.
- Never kill processes by pattern (`pkill -f node`): use cleanup, which checks each process first.
