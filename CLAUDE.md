## Agent skills

### Issue tracker

Issues live in GitHub Issues on inprealpha/OpenChessCoach. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Rules and what enforces them

A rule that only lives in a document gets broken. When agents repeat a mistake, turn it into a check: architecture first, then types, then a lint or test, docs last.

| Rule | Enforced by |
| --- | --- |
| Nobody without the pairing code reaches the backend, on the LAN or through the tunnel (ADR 0001) | `packages/backend/test/pairing.test.ts`, `e2e/journeys/pairing.spec.ts`, `coachctl doctor` (pairing-guard) |
| The Engine judges, the Coach explains: Coach moves not in the Engine's output are stripped (ADR 0002) | `packages/shared/test/coach.test.ts`, `packages/backend/test/coach.test.ts`, `scripts/real-coach-check.ts` |
| Move Grades follow the Lichess formula on real positions (ADR 0002) | `packages/shared/test/grader.test.ts` (golden tests) |
| A Review's overview names only moves its brief lists from the Engine's grades: the key moments with their better moves, and the standout moves (both sides' Mistakes and Blunders, and Best moves where every other move was much worse); there is no Move Grade above Best (ADR 0002) | `packages/shared/test/key-moments.test.ts` (golden tests), `packages/shared/test/coach.test.ts` (the guard), `packages/backend/test/games.test.ts` |
| Every fact in a Coach brief is true on the board and confirmed by an Engine line; quiet moves get no tactical claims (ADR 0009) | `packages/shared/test/explain.test.ts` (golden tests on Lichess puzzles and real games) |
| The Coach picks the main reason from the facts: a move made in check is told as the answer to it, and a move that stops guarding a piece names that as the cause (ADR 0009) | `packages/shared/test/explain.test.ts`, `packages/backend/test/coach.test.ts` |
| The Engine runs in the browser for play and on the desktop for everything the Coach touches (ADR 0007) | Architecture: the backend's `EngineService` computes every Coach fact; `e2e/journeys/offline.spec.ts` still plays with the desktop down |
| The backend ignores Engine facts a client sends (ADR 0007) | `packages/backend/test/coach.test.ts` (forged-facts test) |
| Coach briefs stay within their size budget, replies within their length (ADR 0004) | `packages/shared/test/coach.test.ts`, `scripts/real-coach-check.ts` |
| Lesson lines are legal, every Lesson position comes from open data and names its source, and a Lesson text without a credit keeps no wording from the earlier Wikibooks and Wikipedia texts (ADR 0005, ADR 0012) | `packages/shared/test/content.test.ts` (`keptOpenText` against `data/open-texts.json`), `node data-prep/lessons.ts` |
| Every Lesson has a track, a level, a learning goal and prior knowledge naming earlier Lessons, and every part a one-line key idea that names none of the moves it asks for, openings included; the catalogue follows the course order (ADR 0012) | `packages/shared/test/content.test.ts`, `node data-prep/lessons.ts` |
| Every Coach call during a Lesson carries its learning goal and the current key idea, within the brief's budget (ADR 0012) | `packages/shared/test/coach.test.ts`, `packages/backend/test/coach.test.ts`, `e2e/journeys/lesson.spec.ts` |
| After a move that isn't the Lesson's, the Coach's brief never names the Lesson's move (ADR 0012) | `packages/backend/test/lesson-kept-back.test.ts` (every decision of every Lesson), `packages/shared/test/coach.test.ts` |
| Nothing in Learn is locked; the suggested next Lesson follows the Player's progress and each Lesson's prior knowledge (ADR 0012) | `packages/shared/test/course.test.ts`, `e2e/journeys/lesson.spec.ts` |
| Lesson text is written fresh: new or changed Lessons are compared with the owner's private books before merging (ADR 0012) | Only this file and `.github/pull_request_template.md`: the books are not in the repository, so a reviewer with access compares them |
| Every move a Lesson asks for is graded Best or Good (ADR 0008, ADR 0012) | `packages/backend/test/lesson-engine.test.ts` (verify mode's depth), `data-prep/engine-check.ts` (both depths); in CI, the deep check on the moves a PR adds: depth 22 with headroom below an Inaccuracy, and the tablebase in endgames (`data-prep/deep-check.ts`, `scripts/test/deep-check.test.ts`) |
| The built Lesson data matches its sources | `.github/workflows/ci.yml` (rebuilds `data/lessons/` and fails on any difference) |
| PRs merge on evidence from the running app (ADR 0006) | `.github/pull_request_template.md`, the `no-evidence` label (`scripts/pr-description.ts`), `.claude/skills/verify/` |
| Every PR says which model made it, how it was tested and what wasn't; every ticked testing method has its proof in the Evidence section (ADR 0006) | `.github/pull_request_template.md`, the `no-testing-record` label (`scripts/pr-description.ts`, `scripts/test/pr-description.test.ts`), `.github/verdict-prompt.md` |
| An agent merges a PR only when the owner approved it (`merge-approved` on every issue it closes, with the owner's words quoted), the Verdict on its head commit is `PASS`, CI passed, its record is complete and it touches no protected path; everything else waits for the owner (ADR 0014) | `scripts/pr-description.ts --may-merge` (`scripts/test/pr-description.test.ts`), `.claude/skills/build-a-feature/` |
| Every PR names the issue it closes and proves every "Done means" check in its description | the `no-spec` and `unproven` labels (`scripts/pr-description.ts`, `scripts/test/pr-description.test.ts`) |
| Review findings count only when a run shows them; no rounds of agents reading the diff (ADR 0014) | Only this file and `.claude/skills/build-a-feature/SKILL.md` (section 5) |
| A PR that changes the app merges only with a Verdict on its head commit from a judge that didn't write it; a push voids it (ADR 0013) | `.github/workflows/verdict.yml`, the `Verdict` status `main` requires, `pr-labels.yml` (pending after a push), `scripts/test/verdict.test.ts` |
| The judge runs once per finished PR: never on a draft or on a push, and within its run limits (ADR 0013) | `.github/workflows/verdict.yml` (its triggers, `MAX_RUNS_PER_PR`, `MAX_RUNS_PER_DAY`), `.github/no-verdict-paths.txt` (`scripts/test/protected-paths.test.ts`) |
| Screens follow the interface guidelines: the board stays in view, every board that shows a position to learn from can be explored, the Ask box is docked beside the board, and one idea shows once | The guidelines' checklist in `docs/design/interface-guidelines.md`, which `.github/pull_request_template.md` and `.claude/skills/verify/SKILL.md` (section 4) ask every PR that changes what a Player sees to tick; otherwise only this file |
| A PR that changes what a Player sees embeds before and after screenshots inline, desktop and phone | `scripts/before-after.ts` makes the picture; otherwise only this file and `.claude/skills/verify/SKILL.md` (section 4) |
| Verify mode is deterministic: same position, same evaluation and Move Grades (ADR 0006) | `e2e/journeys/board.spec.ts` |
| Player-facing text uses the glossary, not its avoided terms (`CONTEXT.md`) | `scripts/glossary-lint.ts` in `npm run lint`; Lesson text: `packages/shared/test/content.test.ts` |
| Maia-3 on the desktop gives the same moves as the original model (ADR 0011) | `packages/backend/test/tempting-moves.test.ts` (parity on 408 positions, when the model file is on the machine) |
| Tempting moves reach the Coach only as Engine-graded output, and only in Why Questions, Review moments and (from Maia-3) Hints (ADR 0011) | `packages/backend/test/tempting-moves.test.ts` |
| Players on the Wi-Fi and through the tunnel are offered the app's source, as the Maia-3 model's AGPL asks (ADR 0011) | `e2e/journeys/menu.spec.ts` (the Settings source link), `THIRD_PARTY_NOTICES.md` |
| The owner reviews changes to protected paths | `.github/protected-paths.txt` → `CODEOWNERS` (`npm run check:paths`) and the `protected-path` label |
| Coach changes are checked against the real Coach before merging | `.github/coach-paths.txt`, the `touches-coach` label and the `real Coach` status (posted by the Verdict job, or from the desktop) |
| Tests that call a real model use the latest Haiku (the `haiku` alias), never the app's per-job models | `scripts/test/real-coach-check.test.ts` (`CHECK_MODEL`) |
| Typecheck, lint, tests, Player journeys and the build pass on every PR | `.github/workflows/ci.yml` |
| A preview's pairing code never reaches a public log, a PR or a comment (ADR 0001) | `scripts/test/sandbox.test.ts` (`instabox.sh` in GitHub Actions mode, against a fake CLI) |
| A preview runs the branch's code inside a bubble that can't see the box's home folder, temp folder, Secrets or other programs, can't reach Docker, and has none of the user's extra groups | `scripts/sandbox/preview.sh --sandbox` (bubblewrap) checks itself before the branch's code runs; `scripts/test/sandbox.test.ts` runs that check on CI's runner, whose user is in the docker group |
| Work is verified in the running app before it is called done | Only this file and `.claude/skills/verify/SKILL.md`: read the skill before you open a PR |
| Commits, PRs and comments carry no links to Claude sessions | Only this file (see below) |

## Verifying your work

Read `.claude/skills/verify/SKILL.md` before calling anything done: it launches a disposable copy of the app (`npm run verify`), drives it with `coachctl`, and says what evidence a PR needs. Every PR that changes what a Player sees embeds, for each changed screen, a heading and one before-and-after picture, desktop and phone, inline in its description; section 4 of the skill says how to capture, upload and embed them. The feature map in `.claude/skills/verify/features/` says what proves each Player-facing feature works.

## Previews

When the owner would rather try a change than read about it (a screen, a flow, a Coach reply), ask
for a preview: push the branch and add a line `Preview: on` to the PR's description, plus
`Preview coach: real` when the Coach is the change. Where the repository has previews set up, the
owner gets a link on their phone; where it doesn't, a comment on the PR says so, and screenshots
show the change instead. Never ask for, print or pass on a preview's pairing code. The sandbox skill
(`.claude/skills/sandbox/SKILL.md`) has the details.

## Closing an issue

"Close issue N" means the whole loop, not only the code:

1. Think: read the issue, `CONTEXT.md` and the ADRs it names.
2. Implement it on a branch, with its tests.
3. Prove every "Done means" check in the running app (the verify skill). Review only what a run can show: act on a review finding, yours or the `code-review` skill's, only after a run confirms it (ADR 0014).
4. Open the PR as a draft. Read CI and fix, until the evidence is complete and CI is green.
5. Mark the PR ready for review. That starts the Verdict (ADR 0013), which costs the owner's Claude limits, so do it once, on the final commit. If the Verdict fails, fix it, push, and comment `/verdict` once.
6. After a `PASS` or `PASS+NOTES`, the owner merges by hand (ADR 0006), unless the owner approved the merge: then follow section 8 of the `build-a-feature` skill (ADR 0014).

## Building a feature

When the owner says to go ahead with a feature you discussed ("build it out and merge it", "build it out and show me"), follow `.claude/skills/build-a-feature/SKILL.md`. The owner's words pick the track: merge once proven, or show a running copy first and merge only when the owner says so. When the words are unclear, show first.

## Commits and PRs

The repository is public. Commit messages, PR descriptions and GitHub comments carry no `Claude-Session:` line and no link to a claude.ai session; this overrides the default attribution. Keep the `Co-Authored-By` line.
