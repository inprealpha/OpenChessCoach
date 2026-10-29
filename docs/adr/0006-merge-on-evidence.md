# PRs merge on evidence from the running app

A PR merges only on evidence that the change works in the running app, never on green CI or on the authoring agent saying it's done. The evidence comes from a project verification skill that launches a throwaway copy of the app, drives it the way the Player would, and captures screenshots, command output and database readbacks. The idea comes from Lauren Tan's pstack: an agent that can check its own work against the real thing can be left alone, and one that can't just produces more work for a human to review. Agents prepare and verify PRs, but the owner merges them by hand until the verdicts have proven reliable. After that, auto-merge can be turned on for PRs that touch nothing protected.

## Consequences

- The Coach sits behind a seam with a fake Coach that returns recorded replies. All automated verification uses the fake Coach, so ordinary PRs cost none of the owner's Claude limits.
- A PR that touches the Coach (its prompts, the brief builder, the guard on Coach moves) is also verified against the real Coach. That check runs with the owner's Claude login, in the Verdict job (ADR 0013) or in a Claude Code session on the owner's desktop, and the PR can't merge until it passes. The Coach's wording varies between runs, so this check asserts structure rather than exact text: every move shown is legal and came from the Engine, the reply stays within its length budget, and it uses the glossary's terms.
- Decisions in the ADRs are enforced by code where possible rather than left to agents reading them. One example is a backend guard that rejects any Coach move missing from the Engine's output (ADR 0002). Another is a test that fails when a Coach brief grows past its size budget (ADR 0004).
- The agent that judges a PR is never the agent that wrote it, and its verdict applies only to the exact code it checked, so any new push needs a new verdict. The judge runs in a GitHub Action, once per finished PR (ADR 0013).
- Some paths always need the owner's review, even once auto-merge is on: the ADRs, `CONTEXT.md` and `CLAUDE.md`, pairing and security code, licensing and bundled Lesson data, CI configuration, and the verification skill itself. Keeping the checks outside the agents' reach means an agent can't quietly weaken the check that judges it.
- Every `ready-for-agent` ticket states what "done" means as checks an agent can run.
- The research behind this decision is in `docs/research/verifiability-for-agent-merges.md`.
