<!-- A PR merges on evidence from the running app, not on a claim that it is done (ADR 0006).
Open it as a draft; mark it ready for review on the final commit, which starts the Verdict (ADR 0013). -->

## What changed

<!-- Before: what a Player saw. After: what they see now. -->

Closes #

## Done means

<!-- Copy the ticket's "Done means" checks and tick each one you proved below. -->

- [ ]

## How this was made

<!-- The main model and the tool it ran in (for example "Made with Claude Opus 5.5 in Claude Code (cloud)"),
or "Made by hand". Never guess the model: write the one you are running as.
Tick each way the change was tested; every ticked box needs its proof in Evidence below.
"Not tested" is required: say what you left out, or "nothing".
A PR without these gets the no-testing-record label. -->

Made with

Tested with:
- [ ] Automated tests: `npm test` and the Player journeys
- [ ] Verify mode with the fake Coach, driven by the agent (`coachctl`, Playwright)
- [ ] The real Coach, on a real Claude subscription (the real-Coach check, or used by hand)
- [ ] Used by hand in the running app (where: desktop browser, phone, InstaBox preview)

Not tested:

## Evidence

<!--
Proof from the running app, following .claude/skills/verify/SKILL.md:
- the commands you ran (npm run verify, coachctl ...) and their JSON output;
- screenshots or accessibility snapshots from evidence/<runId>/;
- database readback (coachctl db get <table>) for any side effect;
- the Player journeys and tests you added or ran;
- for a change to what a Player sees, the checklist at the end of docs/design/interface-guidelines.md,
  ticked at desktop and phone sizes.
A PR with nothing here gets the no-evidence label.
-->

## Review notes

<!-- Anything the owner should look at: protected paths touched, Coach changes (they need the
real-Coach check from the desktop), deviations from the ticket, follow-ups. -->

<!-- Preview, where the repository turns previews on (.claude/skills/sandbox/SKILL.md): ready PRs get
one, and drafts with the "preview" label or a line "Preview: on". For another seed, add a line
"Preview seed: empty" (or many-games, no-phone). -->

<!-- New or changed Lesson text (data/lesson-sources/): say who compared it with the owner's books
and found no copied or closely followed wording, examples or order (ADR 0012). -->
