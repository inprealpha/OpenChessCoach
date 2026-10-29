import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeowners, matches, matching, needingVerdict, readList } from '../protected-paths.ts';

const protectedList = readList(readFileSync(new URL('../../.github/protected-paths.txt', import.meta.url), 'utf8'));
const coachList = readList(readFileSync(new URL('../../.github/coach-paths.txt', import.meta.url), 'utf8'));

describe('path lists', () => {
  it('CODEOWNERS is generated from the protected-path list', () => {
    expect(readFileSync(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8')).toBe(codeowners(protectedList));
  });

  it('protects the decisions, pairing, licensing, CI and the verify skill', () => {
    const files = ['docs/adr/0001-one-owner-per-install.md', 'CONTEXT.md', 'packages/backend/src/pairing.ts', 'data/lessons/italian-game.json', '.github/workflows/ci.yml', '.github/CODEOWNERS', '.claude/skills/verify/SKILL.md', 'packages/web/src/App.svelte', 'README.md'];
    expect(matching(files, protectedList)).toEqual(files.slice(0, 7));
  });

  it('finds the PRs that touch the Coach', () => {
    const files = ['packages/backend/src/coach/prompts.ts', 'packages/shared/src/coach/brief.ts', 'packages/shared/src/grader.ts', 'packages/web/src/screens/Review.svelte'];
    expect(matching(files, coachList)).toEqual(files.slice(0, 2));
  });
});

describe('the no-Verdict list (ADR 0013)', () => {
  const noVerdictList = readList(readFileSync(new URL('../../.github/no-verdict-paths.txt', import.meta.url), 'utf8'));

  it('lets docs, tests and process files through, and judges everything else', () => {
    const files = ['docs/adr/0013-the-verdict-runs-once-per-finished-pr.md', 'README.md', 'packages/shared/test/grader.test.ts', 'packages/backend/test/coach.test.ts', 'e2e/journeys/review.spec.ts', '.github/workflows/verdict.yml', '.claude/skills/verify/SKILL.md', 'scripts/verdict.ts', 'scripts/glossary-lint.ts', 'packages/web/src/App.svelte', 'packages/shared/src/grader.ts', 'data/lessons/italian-game.json', 'package-lock.json', 'scripts/real-coach-check.ts', 'scripts/test-helper.ts', 'site/index.html'];
    expect(needingVerdict(files, noVerdictList)).toEqual(files.slice(9));
  });

  it('matches a * within one folder name only', () => {
    expect(matches('packages/web/test/a.test.ts', 'packages/*/test/')).toBe(true);
    expect(matches('packages/web/src/test/a.ts', 'packages/*/test/')).toBe(false);
    expect(matches('packages/web/testing/a.ts', 'packages/*/test/')).toBe(false);
    expect(matches('docs/a.md', 'docs/*.md')).toBe(true);
    expect(matches('docs/adr/a.md', 'docs/*.md')).toBe(false);
  });
});
