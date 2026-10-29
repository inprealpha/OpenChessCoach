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
| Every fact in a Coach brief is true on the board and confirmed by an Engine line; quiet moves get no tactical claims (ADR 0009) | `packages/shared/test/explain.test.ts` (golden tests on Lichess puzzles and real games) |
| The Engine runs in the browser for play and on the desktop for everything the Coach touches (ADR 0007) | Architecture: the backend's `EngineService` computes every Coach fact; `e2e/journeys/offline.spec.ts` still plays with the desktop down |
| The backend ignores Engine facts a client sends (ADR 0007) | `packages/backend/test/coach.test.ts` (forged-facts test) |
| Coach briefs stay within their size budget, replies within their length (ADR 0004) | `packages/shared/test/coach.test.ts`, `scripts/real-coach-check.ts` |
| Lesson lines are legal, every Lesson position comes from open data and names its source, and a Lesson text without a credit keeps no wording from the earlier Wikibooks and Wikipedia texts (ADR 0005, ADR 0012) | `packages/shared/test/content.test.ts` (`keptOpenText` against `data/open-texts.json`), `node data-prep/lessons.ts` |
| Every Lesson has a track, a level, a learning goal and prior knowledge naming earlier Lessons, and every part a one-line key idea that names none of the moves it asks for; the catalogue follows the course order (ADR 0012) | `packages/shared/test/content.test.ts`, `node data-prep/lessons.ts` |
| Every Coach call during a Lesson carries its learning goal and the current key idea, within the brief's budget (ADR 0012) | `packages/shared/test/coach.test.ts`, `packages/backend/test/coach.test.ts`, `e2e/journeys/lesson.spec.ts` |
| Nothing in Learn is locked; the suggested next Lesson follows the Player's progress and each Lesson's prior knowledge (ADR 0012) | `packages/shared/test/course.test.ts`, `e2e/journeys/lesson.spec.ts` |
| Lesson text is written fresh: new or changed Lessons are compared with the owner's private books before merging (ADR 0012) | Only this file and `.github/pull_request_template.md`: the books are not in the repository, so a reviewer with access compares them |
| Every move a Lesson asks for is graded Best or Good (ADR 0008, ADR 0012) | `packages/backend/test/lesson-engine.test.ts` (verify mode's depth), `data-prep/engine-check.ts` (both depths) |
| PRs merge on evidence from the running app (ADR 0006) | `.github/pull_request_template.md`, the `no-evidence` label, `.claude/skills/verify/` |
| A PR that changes what a Player sees embeds before and after screenshots inline, desktop and phone | `scripts/before-after.ts` makes the picture; otherwise only this file and `.claude/skills/verify/SKILL.md` (section 4) |
| Verify mode is deterministic: same position, same evaluation and Move Grades (ADR 0006) | `e2e/journeys/board.spec.ts` |
| Player-facing text uses the glossary, not its avoided terms (`CONTEXT.md`) | `scripts/glossary-lint.ts` in `npm run lint`; Lesson text: `packages/shared/test/content.test.ts` |
| Maia-3 on the desktop gives the same moves as the original model (ADR 0011) | `packages/backend/test/tempting-moves.test.ts` (parity on 408 positions, when the model file is on the machine) |
| Tempting moves reach the Coach only as Engine-graded output, and only in Why Questions, Review moments and (from Maia-3) Hints (ADR 0011) | `packages/backend/test/tempting-moves.test.ts` |
| Players on the Wi-Fi and through the tunnel are offered the app's source, as the Maia-3 model's AGPL asks (ADR 0011) | `e2e/journeys/menu.spec.ts` (the Settings source link), `THIRD_PARTY_NOTICES.md` |
| The owner reviews changes to protected paths | `.github/protected-paths.txt` → `CODEOWNERS` (`npm run check:paths`) and the `protected-path` label |
| Coach changes are checked against the real Coach before merging | `.github/coach-paths.txt`, the `touches-coach` label and the `real Coach` status |
| Tests that call a real model use the latest Haiku (the `haiku` alias), never the app's per-job models | `scripts/test/real-coach-check.test.ts` (`CHECK_MODEL`) |
| Typecheck, lint, tests, Player journeys and the build pass on every PR | `.github/workflows/ci.yml` |
| Work is verified in the running app before it is called done | Only this file and `.claude/skills/verify/SKILL.md`: read the skill before you open a PR |
| Commits, PRs and comments carry no links to Claude sessions | Only this file (see below) |

## Verifying your work

Read `.claude/skills/verify/SKILL.md` before calling anything done: it launches a disposable copy of the app (`npm run verify`), drives it with `coachctl`, and says what evidence a PR needs. Every PR that changes what a Player sees embeds, for each changed screen, a heading and one before-and-after picture, desktop and phone, inline in its description; section 4 of the skill says how to capture, upload and embed them. The feature map in `.claude/skills/verify/features/` says what proves each Player-facing feature works.

## Commits and PRs

The repository is public. Commit messages, PR descriptions and GitHub comments carry no `Claude-Session:` line and no link to a claude.ai session; this overrides the default attribution. Keep the `Co-Authored-By` line.
