# Agents merge what the owner approved and the Verdict passed

ADR 0006 says the owner merges every PR by hand "until the verdicts have proven reliable", and ADR 0013 says auto-merge can later require the `Verdict` status. This ADR takes that step, for PRs the owner approved. The owner discusses a feature with an agent, then says either "build it out and merge it" or "build it out and show me". In the first case the words approve the merge up front. In the second, the agent shows a running copy or several options first, collects the owner's feedback, and only gets the approval when the owner says to merge. Either way, the approval is recorded as the `merge-approved` label on the issue, with a comment that quotes the owner's words. The `build-a-feature` skill holds the two tracks.

An agent may merge a PR only when `node scripts/pr-description.ts --may-merge <pr>` says every rule holds:

- every issue the PR closes has `merge-approved`;
- the `Verdict` on the head commit is `PASS`, or the "no Verdict needed" pass a docs, tests or process change gets (ADR 0013). `PASS+NOTES` goes to the owner, who reads the notes;
- the `real Coach` status, Checks, Player journeys and Label for review pass on that same commit;
- the description names its issue, proves every "Done means" check, and has its evidence and testing record (no `no-spec`, `unproven`, `no-evidence` or `no-testing-record`);
- the PR touches no protected path.

The agent merges that exact commit (`gh pr merge --squash --match-head-commit`), and leaves a comment that lists the rules and quotes the approval. Anything else waits for the owner, as before.

## Why not review rounds

The owner used to ask for rounds of adversarial reviewers with fresh context after every "go ahead". Lauren Tan, whose pstack this setup follows (ADR 0006), has since found that agents reviewing code without running it mostly spend tokens on nitpicks and features nobody needs, and that empirical checks (running the change) and deterministic checks (tests, types, formal verification) do far more for the same tokens. So the trust behind an agent merge comes from proof: every "Done means" check run in verify mode, CI, and the Verdict, a judge that runs the app. A review finding counts only when a run shows it.

## Considered options

- **A repository-wide switch for agent merging.** Simpler, but it lets agents merge things the owner never looked at, including subjective work the owner wanted to try first. Approval per feature, in the owner's words, keeps the owner's judgement where it matters and costs one sentence where it doesn't.
- **GitHub auto-merge on a passing Verdict.** It lands whatever head is ready when the checks pass, and can't check the approval label or `PASS` against `PASS+NOTES`. The checker can.

## Consequences

- The label is a record, not a lock. Agents work under the owner's GitHub account, so an agent could add `merge-approved` itself (the limit ADR 0013 describes). Every agent merge quotes the owner's words, so an approval nobody gave stands out.
- The owner withdraws an approval by removing the label. The check reads labels live, right before the merge.
- Protected paths always wait for the owner, so an agent can't merge a change to the rules that let it merge.
- A PR that names no issue, or leaves a "Done means" check unticked, gets the `no-spec` or `unproven` label, so unproven work stands out even when the owner merges it by hand.
