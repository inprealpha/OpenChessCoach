---
name: build-a-feature
description: Build a feature the owner has discussed and agreed, from "go ahead" to a proven PR, and merge it when the owner approved the merge. Use when the owner says to go ahead with a feature you discussed, such as "build it out and merge it" or "build it out and show me", and for the steps that "close issue N" shares with it.
---

# Build a feature

The owner discusses a feature with you, then says "go ahead". They want to trust the result without
reading the code (ADR 0006), and to let you merge what they approved (ADR 0014). The effort goes into
running the change, not into reading it: every claim is proven by a run, and a finding nobody ran is
dropped.

Words: use the terms in `CONTEXT.md`. Proof follows `.claude/skills/verify/SKILL.md`.

## 1. Pick the track from the owner's words

| The owner says | Track |
| --- | --- |
| "This plan looks good, build it out and merge it", "go ahead and merge it when it's done", "ship it" | **Build and merge**: the words approve the merge up front |
| "Build it out and show me", "show me some versions", "let me try it first", "I'll tell you what I like" | **Show me first**: no merge until the owner says so |
| Anything else, such as a bare "go ahead" or "build it" | **Show me first** |

Never merge on a guess. When the words don't clearly approve the merge, show first.

## 2. Write down what was agreed

Create an issue with the ticket template's sections (`.github/ISSUE_TEMPLATE/ticket.md`), in the
words of `CONTEXT.md`:

```bash
gh issue create --title "<what a Player can do>" --label ready-for-agent --body-file issue.md
```

Its "Acceptance criteria (done means)" are checks you can run against the app: a journey that
passes, a `coachctl` command and the JSON it should print, a database row, a screen at desktop
(1280×800) and phone (390×844) sizes, the interface guidelines' checklist for a screen that changes.
"It looks right" is not a check. Link the issue to the owner and carry on: they correct it when they
want to, and you don't wait for them.

**Build and merge only:** record the approval now. Never add this label without the owner's words.

```bash
gh label create merge-approved --color 0E8A16 --description "The owner approved merging this once it is proven (ADR 0014)" 2>/dev/null || true
gh issue edit <n> --add-label merge-approved
gh issue comment <n> --body 'Merge approved by the owner: "<their exact words>" (<where: the session, the date>).'
```

Never put a link to a Claude session in the comment (CLAUDE.md).

## 3. Show me first: show before finishing

Skip this section on the build-and-merge track.

1. **Build what there is to see.** When there are several reasonable directions, build two or three
   options. When there is one clear direction, build that one. Keep options on one branch behind a
   temporary switch (for example a query parameter or a route per option), so one running copy shows
   them all. Prove only that each option runs: no full proof yet.
2. **Show it.** Push the branch and give the owner a preview link they can open on a phone, as the
   `sandbox` skill says (`.claude/skills/sandbox/SKILL.md`); the `--seed` option picks the data a
   screen needs. Add, for each option, a before-and-after picture at desktop and phone sizes
   (`scripts/before-after.ts`, as in section 4 of the verify skill), so the owner sees the change at
   a glance. Never post the preview's pairing code anywhere public. When no preview can run, send the
   pictures and the exact commands to run that option locally.
3. **Collect the feedback and stop.** The owner says what is good, what isn't, and what is decent
   but needs work. Put each round on the issue as a comment, update its "Done means" checks to match
   what the owner asked for last, and build the next version. Repeat until the owner is happy.
4. **Wait for the merge approval.** When the owner says to merge, record it as in step 2 (the label
   and the quoted words). Then remove the losing options and the switch, and go on with section 4.
   If the owner never says to merge, the PR waits for them.

## 4. Build and prove

1. Build on a branch in its own worktree, with tests at the highest seam that exists.
2. Prove every "Done means" check with the verify skill: launch, doctor, drive, evidence, cleanup.
   Put each check's command and its output (trimmed to what proves it) in the PR's Evidence section.
   Where a check can be a script or a journey, write it, so anyone can run it again.
3. A check you couldn't run stays unticked and is reported as "not proven". It is never a pass.
4. Run the gate from the verify skill once, on the final commit.

## 5. Review only what a run can show

Don't run rounds of agents reading the diff: they find nitpicks and features nobody needs, and cost
the owner's limits. Instead:

- **Optionally, one "break it" pass** on a risky change: try to break it in the running app or with a
  test. Keep a finding only when a run shows it: a failing test, a `coachctl` output, a screenshot.
  Report each kept finding with its command and output. Drop the rest.
- The `code-review` skill is a tool, not a step. Act on one of its findings only after a run confirms it.
- Judge design and feel against the issue's checks and the interface guidelines' checklist, with
  screenshots, not with opinions.

## 6. Put every correction where it stops the next mistake

When the owner corrects you, fix the case at hand, then encode the lesson as high as it goes:

1. the code's structure (a type, a module boundary, a guard), so the mistake can't be written;
2. a lint or a test, so the mistake fails CI;
3. prose (a skill, CLAUDE.md, an ADR) only when neither fits.

Human review is the last resort. List each lesson and where it went under "Review notes" in the PR.

## 7. Open the PR, then the Verdict

1. Open it as a draft (`gh pr create --draft`) with the template filled in:
   - `Closes #<n>` with the issue's number;
   - "Done means": the issue's checks, each ticked only when its proof is in Evidence;
   - "How this was made" and "Evidence", as the verify skill says.
2. Check the description before you push it:

   ```bash
   node scripts/pr-description.ts < body.md   # prints the labels it would get; empty means complete
   ```

3. When CI is green and the evidence is complete, mark it ready once, on the final commit
   (`gh pr ready <pr>`). That starts the Verdict (ADR 0013).

## 8. Merge, only what the owner approved

When the Verdict has posted on the head commit:

```bash
node scripts/pr-description.ts --may-merge <pr>
```

It reads the PR from GitHub and prints `mayMerge`, the head `sha`, the rules `met` and the
`problems`, and exits 0 only when every rule holds:

- every issue the PR closes has `merge-approved`;
- the Verdict on the head commit is `PASS` (not `PASS+NOTES`), or "no Verdict needed";
- the real Coach status, Checks, Player journeys and Label for review pass on that commit;
- the description is complete (no `no-evidence`, `no-testing-record`, `no-spec` or `unproven`);
- the PR touches no protected path.

When it exits 0, merge that exact commit, then confirm it landed:

```bash
gh pr merge <pr> --squash --match-head-commit <sha>
gh pr view <pr> --json state,mergedAt --jq '.state'   # MERGED
gh pr comment <pr> --body-file merge-note.md
```

The merge note lists each rule from `met` and quotes the owner's approval from the issue.

When it exits 1, don't merge. Tell the owner what the `problems` say. `PASS+NOTES` and protected
paths always go to the owner. Fix anything else (the record, CI, a `FAIL`) and check again. Never add
`merge-approved` yourself to get past it, and never turn on GitHub's auto-merge.

## When something goes wrong

- The owner removes `merge-approved`: that withdraws the approval. `--may-merge` reads the labels
  live, so check it again right before merging.
- A push after the Verdict leaves the new commit without one: comment `/verdict` once, as the verify
  skill says.
- The issue and the PR disagree: the issue's latest checks win. Update the PR, not the issue.
