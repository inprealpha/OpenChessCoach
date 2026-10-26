# Verifiability: letting agents merge PRs with confidence

Research note for the AI Chess Coach, 12 October 2026. The decision that came out of it is ADR 0006. Since this was written, two points were settled: PRs that touch the Coach are verified against the real Coach in a Claude Code session on the owner's desktop, and running the independent judge as a cloud session is deferred.

## The short answer

An agent can merge on its own only when something other than the agent's word proves the change works. Lauren Tan's pstack is built on that one idea. Its rule is "trust artefacts, not self-reports": a passing build, green CI, or an agent saying "done" is not proof. Proof is the real app, driven the way the Player would drive it, with evidence (screenshots, DB rows, command output) that anyone can re-run.

For this app that means four things, built from the very first PR:

1. **A verification skill for the chess coach.** A committed script-plus-instructions that launches the app with a fake Coach and a throwaway database, drives it like a Player, and saves evidence. A **feature map** lists every feature (Engine Game, Review, Lesson, Puzzle, pairing, and so on) and the exact end state that proves it works.
2. **The ADRs turned into automatic checks.** Most of the five ADRs are rules a machine can enforce, such as "every move the Coach shows must be legal and come from the Engine".
3. **An independent verdict on every PR.** A fresh agent that didn't write the code runs the verification skill against the PR and posts PASS or FAIL. CI green alone never merges.
4. **A trust ladder for merging.** Agents prepare, the owner clicks merge, until the verifier's verdicts have proven reliable. Then auto-merge switches on for low-risk areas, while ADRs, the glossary, security and licensing stay with the owner.

The rest of this note explains where each idea comes from and how it fits this app.

---

## 1. What pstack is

pstack is Lauren Tan's open-source (MIT) plugin of agent skills, published in Cursor's plugin repository (version 0.15.20 when I read it). Tan worked on the React Compiler at Meta and then at Cursor. Tan says pstack has let them ship around 2,000 PRs a month to production "with high confidence". That number is self-reported.

It has three layers:

- **`/poteto-mode`**, the one command Tan types. It reads the request, picks one of 23 **playbooks** (bug fix, feature, refactor, babysit a PR, ship a stack, run overnight, and so on) and copies its steps into a to-do list the agent must work through.
- **23 principles**, short rules like *Prove It Works*, *Build the Lever* and *Sequence Verifiable Units* that agents (and Tan) can name mid-task to steer.
- **Situational skills**, the important ones here being `/create-verification-skill`, `/maintain-verification-skill`, `/interrogate` (several models try to break a diff), `/swarm` (parallel verifiers), `/show-me-your-work` (a decision log) and `/correct` (turn repeated mistakes into checks).

The stated goal is not volume. The README opens with "throughput without quality is not a goal i aspire to. if you want to go fast, go deep first." Parallel agents are the *reward* for trust, not the way to get it.

## 2. Tan's ideas on verifiability

### Verification is the foundation, and the bottleneck

"Verification means that an agent can verify its own work. It can keep going until it succeeds at its task, because it can now close the loop without you being the bottleneck." If an agent can't check its work, it hands you a diff and waits, and adding more agents just gives you more unchecked work to review. In a talk, Tan frames it as *trust first, then parallel*: "without trust, a hundred cloud agents just produce garbage."

### Check the real thing, not a proxy

The *Prove It Works* principle: "Verify every task output by checking the real thing directly. Do not infer from proxies, self-reports, or 'it compiles.'" The check should match the change:

- a UI change walks the changed flow in the running app;
- a storage change reads the written value back;
- a parser replays a saved input;
- a performance change compares before and after measurements.

The strongest proof is a script someone can re-run, not a one-time look. A confident "done" with no evidence is a red flag.

### The verification skill and the feature map

Part 1 of Tan's guide calls this the foundation of everything. `/create-verification-skill` studies the repo and writes a project-local skill with five fixed sections:

| Section | What it answers |
|---|---|
| **Launch** | The exact command that starts the app from an empty data folder, and how to tell it's *usable*, not just running. |
| **Doctor** | One read-only check: is this instance worth driving? |
| **Drive** | How to operate the app like a user, with real selectors from this repo. |
| **Evidence** | What to capture and where: the action *and* the resulting state, plus side effects like database rows. |
| **Cleanup** | Tear down what this run started, but keep the evidence. |

Next to it sits a **feature map**: one short file per user-facing feature saying what it is, how a user reaches it, how to drive it, and what observable end state proves it works, plus gotchas. A rule worth copying: if seed data can't support a journey, the journey reports a failure; "never weaken the journey to make it pass." The generator must run its own skill end to end once before handing it over: "a generated skill that was never executed is a draft, not a deliverable." A second skill, `/maintain-verification-skill`, re-checks the map against the app daily, because "a feature map rots the moment the app changes."

### Build the lever

Instead of agents writing throwaway click-scripts every time, build a small control CLI the skill calls. Tan's guidance on what makes a CLI agents use well: a few composable commands, `--dry-run` on anything destructive, JSON output, and error messages that say what to do. Fewer tokens per run, and every run is repeatable. Same for dev setup: seeded data and one command that brings the environment up identically every time.

### Fix mistakes at the strongest layer

The `/correct` skill ranks where a fix for a repeated agent mistake should live, strongest first:

1. **Architecture** makes the mistake impossible (one owner per piece of state, one supported way to do each task, internals hidden so the wrong import fails).
2. **Types** make the bad state unwritable; failing that, a **lint or CI check whose error message names the fix**.
3. **Behavior tests.** A test that would still pass if every function returned nothing gets fixed or deleted.
4. **Docs and agent rules last**, only for judgment calls, because "nothing fails when an agent skips them."

Every new check must be proven to fail on a real past mistake. The repo keeps a table pairing each rule with what enforces it.

### Who is allowed to merge

This is the part most relevant to the owner's question, from pstack's *Babysit*, *Shipping* and *Autopilot-full* playbooks:

- **Getting a PR green never authorizes merging.** "Babysitting never authorizes merging." Merging is a separate decision.
- **The judge is never the author.** "Safe means a verdict from an agent that did not write the code. CI green is not a verdict, and an approving bot review is not a verdict." One fresh verifier per PR drives the real app on the PR's code and on the base branch and returns `PASS`, `PASS+NOTES` or `FAIL`.
- **A verdict is tied to the exact change.** The *Shipping* playbook records a fingerprint of the diff (`git patch-id`). If a rebase or new push changes the code, the old verdict no longer counts.
- **Full autonomy is an explicit grant plus a clean verdict.** In *Autopilot-full*, an owner agent may merge its own PR only when the operator granted full autonomy *and* a swarm of independent verifiers returned a clean verdict. The swarm has lanes: re-run the checks, prove the behavior live (this lane is mandatory), two or more code-review lanes each with one focus, and a regression lane that runs the same scenario on the main branch. Items the operator names stay with the operator.
- **A decision log.** Long runs keep a `decisions.tsv` (time, decision, reason, evidence pointer, result) so a human audits decisions in the morning instead of re-reading everything.

### Earn the trust before the loop

From the guide's overnight chapter, a loop is safe to leave alone only when: you've done the task once and know what good looks like; the agent has the same tools you'd use; every stage proves its work and can stop the line; and you've read a few transcripts and turned repeated failures into tools or checks. "Until then, run it while you watch." And a duration isn't a finish condition: "work on this for 4 hours" gives the agent nothing to check.

---

## 3. What this means for the chess coach

### What's easy and hard to verify here

| Part of the app | How verifiable | Why |
|---|---|---|
| Move Grade maths, PGN import, Lesson lines, Puzzle checking | Very easy | Pure functions with known answers. Real Lichess examples make golden tests. |
| Engine (Stockfish WASM) | Easy, with care | Deterministic if run single-threaded with a fixed node count, which ADR 0003 already implies on plain HTTP. |
| Board UI, Engine Games, Reviews, Lessons in the PWA | Easy | Playwright drives the browser; Chromium is already in the cloud agents' environment. |
| Backend: WebSocket, pairing, SQLite, offline sync | Easy | A small CLI can speak the WebSocket protocol and read the database back. |
| The Coach (Claude Agent SDK) | Hard | It needs the owner's own Claude Code login (ADR 0001), so cloud agents can't call it; it costs the owner's limits; its output varies. |
| Whether the Coach *teaches well* | Not mechanically | It's a judgment call. See section 5. |

The hard rows decide the design: **the Coach must sit behind a swappable seam**, with a fake Coach for every automated check and the real one tested separately on the owner's desktop.

### Design choices that make the app verifiable

These cost little now and a lot to retrofit, so they belong in the first tickets:

- **Ports for everything external.** The Engine, the Coach, the clock and storage each sit behind a small interface. Tests and the verification skill plug in a fake Coach (returns recorded replies), a Node build of Stockfish at fixed depth, a fake clock, and a temporary SQLite file. Matt Pocock's `codebase-design` skill has the vocabulary for this ("deep modules", "seams").
- **The Coach returns structure, not just prose.** Moves come back as data (in UCI notation) next to the explanation. That lets code check them, which is the key to the next section.
- **One command to launch a disposable instance.** For example `npm run dev:verify`: fake Coach, fresh database with seeded Player Profile and games, fixed ports, pairing code printed in JSON.
- **Stable handles in the UI.** Every square, button and panel gets an accessible name or `data-testid`, so agents drive by name, never by screen coordinates.
- **A `coachctl` control CLI** (the lever): `doctor`, `pair`, `play e2e4`, `import-pgn file.pgn`, `review <game>`, `ask-why <move>`, `db get <table>`, `screenshot`. JSON output throughout.

### Turning the ADRs into checks

This is where Tan's "strongest layer first" pays off. Most of the design decisions can be enforced by code instead of hoping agents read the ADRs.

| ADR | Rule | Enforced by |
|---|---|---|
| 0002 Engine judges | Every move the Coach shows is legal and appears in the Engine's candidate list. | A runtime guard on the backend that rejects or strips any Coach move not in the Engine's output, plus a test proving a made-up move is caught. |
| 0002 | Move Grade depends on winning-chance loss, not move rank. | Golden tests with real positions where a fourth-best move is graded good. |
| 0002 | The Coach never evaluates on its own. | Architecture: the Coach's input type contains Engine facts and has no field for its own evaluation, so the code can't express it. |
| 0003 Engine on the client | Board and Engine still work with the desktop off; Coach features grey out; offline Engine Games sync later. | A feature-map journey: stop the backend, play a game, restart, check the game reached SQLite. |
| 0004 Lean Coach calls | Each call is a fresh, compact brief. | A test that builds the brief for a long game and fails if it exceeds a fixed size budget. |
| 0004 | Reviews cover 3 to 5 key moments. | A test on the moment picker with real games. |
| 0001 One owner | Nothing reaches the Coach without the pairing code. | A test that connects without the code and expects refusal, run in CI and by `coachctl doctor`. |
| 0005 Lessons from open data | Every Lesson line is legal; Wikibooks notes carry their CC BY-SA credit. | A data check in CI over the bundled Lesson files. |

The glossary (`CONTEXT.md`) can be partly enforced too: a lint that flags avoided terms ("student", "bot game", "accuracy") in UI strings and code names.

### The feature map for this app

A first map, one file each, following Tan's four headings (sub-features, how to reach it, how to drive it, gotchas):

- **Pairing**: QR code and pairing code, refusal without the code.
- **Engine Game**: play a game, Hint (only here and in Lessons), Live Coaching on and off.
- **Imported Game**: paste PGN; later Lichess and chess.com import.
- **Review**: 3 to 5 key moments, Move Grades shown, Coach explanation present.
- **Why Question**: ask about a move, answer only cites Engine moves.
- **Lesson**: choose moves in an opening, consequences explained.
- **Puzzle**: solve after a Lesson, wrong answer handled.
- **Offline mode**: desktop off, Coach greyed out, sync on return.
- **Player Profile**: Lesson progress and Move Grade counts recorded without a Coach call.

Each "proves it works" line names an end state such as "the game row exists in SQLite with 41 moves" or "the Review panel lists 4 moments, each with a Move Grade", never "the page loaded".

---

## 4. The merge gate: a trust ladder

Following "earn the trust before the loop", autonomy grows in steps. Each step is a GitHub setting or a check, not a promise.

**Step 0: verifiable tickets (now).** Every issue labelled `ready-for-agent` gets a *Done means* section with checks an agent can run, for example: "Done means: `coachctl import-pgn sample.pgn` exits 0, the game appears in the list, and a Review shows 3 to 5 moments." Tickets without one stay `needs-info`. This fits the to-spec and to-tickets flow from Matt Pocock's skills.

**Step 1: the floor (first code PR).** CI runs typecheck (`tsc --strict`, `svelte-check`), lint, unit tests, the ADR checks above and the build. Branch protection on `main` requires them. This is necessary but, in Tan's words, not a verdict.

**Step 2: the verification skill (as soon as there's a screen).** Commit `.claude/skills/verify-coach/` with Launch, Doctor, Drive, Evidence, Cleanup, `coachctl` and the feature map. Every PR body must carry the author agent's evidence (screenshots, command output, DB readback). A CI job runs the feature-map journeys with the fake Coach. A scheduled job keeps the map honest.

**Step 3: an independent verdict (before any auto-merge).** For each PR, a fresh agent that didn't write it runs the verification skill on the PR and on `main`, reads the diff skeptically, and posts PASS, PASS+NOTES or FAIL as a GitHub check, tied to the head commit. Any new push resets it. The owner still clicks merge. This is the calibration period: when the owner disagrees with a PASS, that's a gap to close with a new check (via the `/correct` ordering), not just a fix to that PR.

**Step 4: auto-merge for low-risk areas.** When the verifier's verdicts have matched the owner's own judgment on a run of PRs, turn on GitHub auto-merge for PRs that: come from a `ready-for-agent` ticket, have green CI, have a current PASS from the independent verifier, and touch none of the **protected paths**. A `CODEOWNERS` file makes the owner's review mandatory for those:

- `docs/adr/`, `CONTEXT.md`, `CLAUDE.md` (the decisions and the language);
- pairing, auth and tunnel code (the owner's Claude limits);
- licensing and bundled Lesson data (the CC BY-SA obligation);
- CI config, `CODEOWNERS` and the verification skill itself. Tan's point: keep the contract outside the delegates' write scope, so an agent can't quietly weaken the check that judges it.

**Step 5: keep ratcheting.** Each time the owner corrects an agent or a bug slips through, ask Tan's question in order: can architecture prevent it, can a type or lint catch it, can a test? Add the strongest one, prove it fails on the real mistake, and record the rule and its enforcer in a table in `CLAUDE.md`.

## 5. What can't be verified mechanically: the Coach's teaching

Verification proves *behavior*: the right moves, the right data, the right screens. It can't prove an explanation is *good teaching*. pstack's answer for this kind of question is its *eval* playbook: run the old and new prompt blind on a fixed set of cases and have judges compare. For the chess coach:

- Keep a small, fixed **Coach eval set**: 20 to 30 positions and games with Engine facts attached.
- Hard checks run on every Coach answer: only Engine moves cited, within the length budget, glossary terms used.
- For prompt changes, compare old and new answers blind, judged by a different model with a short rubric (correct reason given, plain language, right level for the Player), and the owner reads a sample.
- Because the real Coach runs on the owner's login, this runs on the owner's desktop (a Remote Control session can do it), not in cloud CI, and only when Coach prompts change.

Coach prompt changes therefore belong on the protected list until the eval set exists.

## 6. Adopt pstack, or borrow from it?

pstack is a **Cursor** plugin. Its skills are markdown files and its ideas carry over, but parts assume Cursor's `/loop`, Cursor cloud agents and Cursor-only control skills, and it overlaps with the Matt Pocock skills already in use. Recommendation: **borrow, don't install**. The pieces worth copying (MIT, with credit):

- the *Prove It Works*, *Build the Lever* and *Sequence Verifiable Units* principles, as a few lines in `CLAUDE.md`;
- `create-verification-skill`'s five-section structure and feature-map format, adapted to `.claude/skills/verify-coach/`;
- the *Shipping* rules for merging: judge isn't author, verdict tied to the patch, CI green isn't a verdict;
- `/correct`'s fix-at-the-strongest-layer order.

## 7. Caveats

- Tan's PR counts (1,000, 2,000 and 2,500 a month in different posts) are self-reported, and some coverage stresses counting *verified merges* rather than PRs.
- Tan's setup runs on a large codebase with real infrastructure. This app is small, so the right size is one verification skill, one verifier agent per PR and a few CI checks, not swarms.
- Tan's own guide says this is a lot of work and trust has to be earned. The ladder above is deliberately slow at the start.

## Sources

Primary:
- [pstack README and source, cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack) (read directly: `principle-prove-it-works`, `principle-build-the-lever`, `principle-sequence-verifiable-units`, `create-verification-skill`, `correct`, playbooks `babysit`, `shipping`, `autopilot-full`)
- [The pstack guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide), especially *06 Verify and ship* and *07 Overnight*
- [The Complete Guide to pstack Pt. 1, Lauren Tan on X](https://x.com/poteto/status/2094457600259842065) and [Pt. 2](https://x.com/poteto/article/2097732320606507506)
- [Example verification skill](https://github.com/poteto/verification-skill-example)

Secondary:
- [Trust First, Then Parallel: What Lauren Tan's Talk Actually Argues](https://redreamality.com/blog/lauren-tan-poteto-trust-before-parallel/)
- [One engineer shipped 2,000 PRs a month to production. Verification is the key. (The New Stack)](https://thenewstack.io/agentic-verification-distributed-systems/)
- [pstack explained (The Neuron)](https://www.theneuron.ai/explainer-articles/pstack-explained-lauren-tans-system-for-trustworthy-ai-agents)
- [pstack: 5 honest checks on 2,500 AI-agent PRs a month (folkfox)](https://folkfox.com/pstack-2500-ai-agent-prs-verification)
