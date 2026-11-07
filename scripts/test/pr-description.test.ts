// The checks on a PR's description behind the no-evidence, no-testing-record, no-spec and unproven labels
// (ADR 0006): the template as shipped earns all four, a filled-in description earns none, and comments
// never count. And the merge decision (ADR 0014): an agent merges only what the owner approved and the
// Verdict passed, and every rule that fails says why on its own.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  closedIssues,
  hasEvidence,
  labelsFor,
  MERGE_APPROVED,
  mergeDecision,
  NO_EVIDENCE,
  NO_SPEC,
  NO_TESTING_RECORD,
  type PrFacts,
  PROTECTED_PATH,
  section,
  testingRecordProblems,
  UNPROVEN,
  unprovenProblems,
  withoutComments,
} from '../pr-description.ts';

const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8');

const made = `## How this was made

Made with Claude Opus 5.5 in Claude Code (cloud).

Tested with:
- [x] Automated tests: \`npm test\` and the Player journeys
- [x] Verify mode with the fake Coach, driven by the agent (\`coachctl\`, Playwright)
- [ ] The real Coach, on a real Claude subscription (the real-Coach check, or used by hand)
- [ ] Used by hand in the running app (where: desktop browser, phone, InstaBox preview)

Not tested: the phone layout in landscape; macOS.
`;

const evidence = `## Evidence

\`npm run verify\` then \`coachctl doctor\`: all checks pass.
`;

const spec = 'Closes #62\n';

const done = `## Done means

- [x] \`coachctl review --game 1\` prints three key moments
- [x] The Review screen at phone size keeps the board in view
`;

const body = (...parts: string[]) => `## What changed\n\nThe Review screen streams first.\n\n${parts.join('\n')}\n## Review notes\n\nNone.\n`;

describe('the PR template', () => {
  it('earns all four labels until it is filled in', () => {
    expect(labelsFor(template)).toEqual([NO_EVIDENCE, NO_TESTING_RECORD, NO_SPEC, UNPROVEN]);
    expect(testingRecordProblems(template)).toHaveLength(3);
  });

  it('passes every check once it names its issue, proves its checks and has its record and evidence', () => {
    const filled = template
      .replace(/^Closes #$/m, 'Closes #62')
      .replace(/(## Done means\n\n<!--[\s\S]*?-->\n\n)- \[ \]$/m, '$1- [x] The template asks for the record')
      .replace(/^Made with$/m, 'Made with Claude Opus 5.5 in Claude Code (cloud).')
      .replace('- [ ] Automated tests', '- [x] Automated tests')
      .replace(/^Not tested:$/m, 'Not tested: nothing.')
      .replace(/(## Evidence\n\n<!--[\s\S]*?-->\n)/, '$1\nAll 239 Player journeys pass.\n');
    expect(labelsFor(filled)).toEqual([]);
  });
});

describe('the "How this was made" section', () => {
  it('is complete with a model line, a ticked box and a "Not tested" line', () => {
    expect(testingRecordProblems(body(made, evidence))).toEqual([]);
    expect(labelsFor(body(spec, done, made, evidence))).toEqual([]);
  });

  it('accepts "Made by hand", "Not tested: nothing" and an upper-case X', () => {
    const byHand = made.replace(/^Made with .*$/m, 'Made by hand.').replace(/^Not tested: .*$/m, 'Not tested: nothing').replace(/\[x\]/g, '[X]');
    expect(testingRecordProblems(body(byHand))).toEqual([]);
  });

  it('reports each missing part on its own', () => {
    expect(testingRecordProblems(body(evidence))).toEqual(['There is no "How this was made" section.']);
    expect(testingRecordProblems(body(made.replace(/^Made with .*$/m, '')))).toEqual(['The "Made with" line is missing or empty.']);
    expect(testingRecordProblems(body(made.replace(/^Made with .*$/m, 'Made with')))).toEqual(['The "Made with" line is missing or empty.']);
    expect(testingRecordProblems(body(made.replace(/\[x\]/g, '[ ]')))).toEqual(['No testing method is ticked.']);
    expect(testingRecordProblems(body(made.replace(/^Not tested: .*$/m, '')))).toHaveLength(1);
    expect(testingRecordProblems(body(made.replace(/^Not tested: .*$/m, 'Not tested:')))).toHaveLength(1);
    expect(labelsFor(body(spec, done, made.replace(/\[x\]/g, '[ ]'), evidence))).toEqual([NO_TESTING_RECORD]);
  });

  it('does not take an empty line for the next line\'s text', () => {
    const empty = '## How this was made\n\nMade with\n\nTested with:\n- [x]\n- [ ] Automated tests\n\nNot tested:\nnothing\n';
    expect(testingRecordProblems(empty)).toHaveLength(3);
  });

  it('ignores answers inside comments', () => {
    const hidden = `## How this was made\n\n<!-- Made with Claude\n- [x] Automated tests\nNot tested: nothing -->\n`;
    expect(testingRecordProblems(hidden)).toHaveLength(3);
  });

  it('finds a heading with more words after it, and ignores headings inside code fences', () => {
    expect(hasEvidence('## Evidence (desktop and phone)\n\n![shot](x.png)\n')).toBe(true);
    const fenced = '## Evidence\n\n```markdown\n## Review notes\n```\n\nScreenshots below.\n';
    expect(section(fenced, 'Evidence')).toContain('Screenshots below.');
    expect(testingRecordProblems('## Evidence\n\n```\n## How this was made\nMade with X\n- [x] a\nNot tested: y\n```\n')).toEqual(['There is no "How this was made" section.']);
  });

  it('ends at the next "##" heading, not at a "###" one', () => {
    expect(section(body(made, evidence), 'How this was made')).not.toContain('coachctl doctor');
    expect(section('## Evidence\n\n### Board after 1. e4\n\n![shot](x.png)\n', 'Evidence')).toContain('![shot]');
  });
});

describe('the Evidence section', () => {
  it('is empty when it only holds comments or whitespace, even a comment over several lines', () => {
    expect(hasEvidence(body(made, '## Evidence\n\n<!--\nthe commands you ran\n-->\n\n'))).toBe(false);
    expect(hasEvidence(body(made, '## Evidence\n\n<!-- one line -->\n'))).toBe(false);
    expect(hasEvidence(body(made, '## Evidence\n'))).toBe(false);
    expect(hasEvidence(body(made))).toBe(false);
  });

  it('counts anything else, and text after a comment', () => {
    expect(hasEvidence(body(made, evidence))).toBe(true);
    expect(hasEvidence(body(made, '## Evidence\n\n<!-- hint -->\nScreenshots below.\n'))).toBe(true);
    expect(hasEvidence('## Evidence\r\n\r\nWindows line endings.\r\n')).toBe(true);
  });

  it('treats a comment left open as running to the end', () => {
    expect(withoutComments('kept <!-- dropped\nstill dropped')).toBe('kept ');
  });
});

describe('the issue a PR closes', () => {
  it('reads GitHub\'s closing words, once per issue', () => {
    expect(closedIssues('Closes #62')).toEqual([62]);
    expect(closedIssues('Fixes #3 and resolves #4. Also closes #3.')).toEqual([3, 4]);
    expect(closedIssues('Closed: #7')).toEqual([7]);
  });

  it('closes nothing with an empty "Closes #", a mention, a comment or code', () => {
    expect(closedIssues('Closes #')).toEqual([]);
    expect(closedIssues('See #62 for the background.')).toEqual([]);
    expect(closedIssues('<!-- Closes #62 -->')).toEqual([]);
    expect(closedIssues('`Closes #62` is how to write it.\n```\nCloses #63\n```\n')).toEqual([]);
    expect(labelsFor(body(done, made, evidence))).toEqual([NO_SPEC]);
  });
});

describe('the "Done means" checks', () => {
  it('are proven when every check is ticked and has words', () => {
    expect(unprovenProblems(body(done))).toEqual([]);
  });

  it('name each check that isn\'t ticked', () => {
    const half = done.replace('- [x] The Review', '- [ ] The Review');
    expect(unprovenProblems(body(half))).toEqual(['"Done means" check not proven: The Review screen at phone size keeps the board in view']);
    expect(labelsFor(body(spec, half, made, evidence))).toEqual([UNPROVEN]);
  });

  it('count a missing section, no ticked check, or an empty box', () => {
    expect(unprovenProblems(body(made))).toEqual(['There is no "Done means" section.']);
    expect(unprovenProblems('## Done means\n\n- [ ] First\n- [ ] Second\n')).toEqual(['No "Done means" check is ticked.']);
    expect(unprovenProblems('## Done means\n\n- [x] First\n- [ ]\n')).toEqual(['A "Done means" check is empty.']);
    expect(unprovenProblems('## Done means\n\n<!-- - [x] hidden -->\n- [ ] First\n')).toEqual(['No "Done means" check is ticked.']);
  });

  it('never take a box inside a code block for a check, here or in "How this was made"', () => {
    expect(unprovenProblems('## Done means\n\n```\n- [x] only inside a code block\n```\n')).toEqual(['No "Done means" check is ticked.']);
    expect(unprovenProblems('## Done means\n\n~~~\n- [x] left open\n')).toEqual(['No "Done means" check is ticked.']);
    expect(unprovenProblems('## Done means\n\n```bash\ncoachctl doctor\n```\n- [x] Doctor passes\n')).toEqual([]);
    expect(testingRecordProblems('## How this was made\n\nMade with X\n```\n- [x] Automated tests\n```\nNot tested: nothing\n')).toEqual(['No testing method is ticked.']);
  });
});

describe('the merge decision', () => {
  const complete = body(spec, done, made, evidence);
  const ready: PrFacts = {
    open: true,
    draft: false,
    body: complete,
    labels: [],
    issueLabels: { 62: ['ready-for-agent', MERGE_APPROVED] },
    statuses: {
      Verdict: { state: 'success', description: 'PASS: every Done means check holds in the running app' },
      'real Coach': { state: 'success', description: 'Does not touch the Coach' },
    },
    checks: { Checks: ['skipped', 'success'], 'Player journeys': ['success'], 'Label for review': ['success', 'success'] },
    protectedFiles: [],
  };
  const decide = (change: Partial<PrFacts>) => mergeDecision({ ...ready, ...change });

  it('lets an agent merge what the owner approved, the Verdict passed and CI proved', () => {
    const d = mergeDecision(ready);
    expect(d.problems).toEqual([]);
    expect(d.mayMerge).toBe(true);
    expect(d.met).toContain(`The owner approved merging issue #62 (${MERGE_APPROVED}).`);
    expect(d.met).toContain('The Verdict on this commit: PASS: every Done means check holds in the running app');
  });

  it('accepts the Verdict a docs, tests or process change gets at once', () => {
    const verdict = { state: 'success', description: 'Changes only docs, tests or process files: no Verdict needed' };
    expect(decide({ statuses: { ...ready.statuses, Verdict: verdict } }).mayMerge).toBe(true);
  });

  it('never merges without the owner\'s approval on every issue, whatever else holds', () => {
    expect(decide({ issueLabels: { 62: ['ready-for-agent'] } }).problems).toEqual([`Issue #62 has no ${MERGE_APPROVED} label: the owner hasn't approved merging it.`]);
    expect(decide({ issueLabels: {} }).mayMerge).toBe(false);
    const two = complete.replace('Closes #62', 'Closes #62\nCloses #63');
    expect(decide({ body: two }).problems).toEqual([`Issue #63 has no ${MERGE_APPROVED} label: the owner hasn't approved merging it.`]);
    expect(decide({ body: two, issueLabels: { 62: [MERGE_APPROVED], 63: [MERGE_APPROVED] } }).mayMerge).toBe(true);
  });

  it('leaves PASS+NOTES, a failed, pending or missing Verdict to the owner', () => {
    const verdict = (state: string, description: string) => decide({ statuses: { ...ready.statuses, Verdict: { state, description } } }).problems;
    expect(verdict('success', 'PASS+NOTES: works; one note')).toEqual(['The Verdict is PASS+NOTES: the owner reads the notes and merges.']);
    expect(verdict('failure', 'FAIL: the board scrolls away')).toEqual(['There is no passing Verdict on this commit (failure: FAIL: the board scrolls away).']);
    expect(verdict('pending', 'No Verdict for this commit: comment /verdict to start the judge')).toHaveLength(1);
    expect(decide({ statuses: { 'real Coach': ready.statuses['real Coach'] } }).problems).toEqual(['There is no passing Verdict on this commit.']);
  });

  it('needs the real Coach status to pass, so a Coach change needs the real-Coach check', () => {
    const coach = { state: 'pending', description: 'Touches the Coach: the Verdict job runs the real-Coach check, or run it on the desktop' };
    expect(decide({ labels: ['touches-coach'], statuses: { ...ready.statuses, 'real Coach': coach } }).problems).toEqual([
      `The real Coach status doesn't pass (pending: ${coach.description}).`,
    ]);
    expect(decide({ labels: ['touches-coach'] }).mayMerge).toBe(true);
  });

  it('needs every required check\'s newest run to pass on the head commit', () => {
    expect(decide({ checks: { ...ready.checks, 'Player journeys': [null, 'success'] } }).problems).toEqual(["Player journeys hasn't passed on this commit."]);
    expect(decide({ checks: { ...ready.checks, Checks: ['failure', 'success'] } }).problems).toEqual(["Checks hasn't passed on this commit."]);
    expect(decide({ checks: { ...ready.checks, Checks: ['skipped'] } }).problems).toEqual(["Checks hasn't passed on this commit."]);
    expect(decide({ checks: { ...ready.checks, Checks: ['cancelled'] } }).problems).toEqual(["Checks hasn't passed on this commit."]);
  });

  it('ignores the older runs a push cancelled or a rerun replaced', () => {
    // The runs PR #64's head commit had when it merged, newest first.
    const checks = {
      Checks: ['success', 'cancelled', 'skipped'],
      'Player journeys': ['success', 'skipped', 'cancelled'],
      'Label for review': ['success', 'success', 'cancelled', 'cancelled'],
    };
    expect(decide({ checks }).mayMerge).toBe(true);
    expect(decide({ checks: { Checks: ['success'], 'Player journeys': ['success'] } }).problems).toEqual(["Label for review hasn't passed on this commit."]);
  });

  it('always leaves protected paths to the owner, from the file list or the label', () => {
    expect(decide({ protectedFiles: ['CLAUDE.md'] }).problems).toEqual(['The PR touches protected paths, which the owner always merges: CLAUDE.md.']);
    expect(decide({ labels: [PROTECTED_PATH] }).problems).toEqual(['The PR touches protected paths, which the owner always merges.']);
  });

  it('refuses an incomplete record, from the description or a label', () => {
    const half = body(spec, done.replace('- [x] The Review', '- [ ] The Review'), made, evidence);
    expect(decide({ body: half }).problems).toEqual([
      `The description's record is incomplete: ${UNPROVEN}.`,
      '"Done means" check not proven: The Review screen at phone size keeps the board in view',
    ]);
    expect(decide({ body: body(spec, done, made) }).problems).toEqual([`The description's record is incomplete: ${NO_EVIDENCE}.`]);
    expect(decide({ labels: [NO_TESTING_RECORD] }).problems).toEqual([`The description's record is incomplete: ${NO_TESTING_RECORD}.`]);
  });

  it('refuses a draft or a closed PR', () => {
    expect(decide({ draft: true }).problems).toEqual(['The PR is a draft.']);
    expect(decide({ open: false }).problems).toEqual(['The PR is not open.']);
  });
});
