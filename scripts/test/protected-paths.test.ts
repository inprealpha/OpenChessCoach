import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeowners, matching, readList } from '../protected-paths.ts';

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
