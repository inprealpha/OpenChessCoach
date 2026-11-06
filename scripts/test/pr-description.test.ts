// The checks on a PR's description behind the no-evidence and no-testing-record labels (ADR 0006):
// the template as shipped earns both, a filled-in description earns neither, and comments never count.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasEvidence, labelsFor, NO_EVIDENCE, NO_TESTING_RECORD, section, testingRecordProblems, withoutComments } from '../pr-description.ts';

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

const body = (...parts: string[]) => `## What changed\n\nThe Review screen streams first.\n\n${parts.join('\n')}\n## Review notes\n\nNone.\n`;

describe('the PR template', () => {
  it('earns both labels until it is filled in', () => {
    expect(labelsFor(template)).toEqual([NO_EVIDENCE, NO_TESTING_RECORD]);
    expect(testingRecordProblems(template)).toHaveLength(3);
  });

  it('passes both checks once the section and the evidence are filled in', () => {
    const filled = template
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
    expect(labelsFor(body(made, evidence))).toEqual([]);
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
    expect(labelsFor(body(made.replace(/\[x\]/g, '[ ]'), evidence))).toEqual([NO_TESTING_RECORD]);
  });

  it('does not take an empty line for the next line\'s text', () => {
    const empty = '## How this was made\n\nMade with\n\nTested with:\n- [x]\n- [ ] Automated tests\n\nNot tested:\nnothing\n';
    expect(testingRecordProblems(empty)).toHaveLength(3);
  });

  it('ignores answers inside comments', () => {
    const hidden = `## How this was made\n\n<!-- Made with Claude\n- [x] Automated tests\nNot tested: nothing -->\n`;
    expect(testingRecordProblems(hidden)).toHaveLength(3);
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
