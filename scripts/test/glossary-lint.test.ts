// The glossary lint is trusted only after it fails on a deliberately broken input.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../../packages/backend/src/coach/prompts.ts';
import { avoidedTerms, lint, type AllowEntry } from '../glossary-lint.ts';

const terms = avoidedTerms(readFileSync(new URL('../../CONTEXT.md', import.meta.url), 'utf8'));
const allow = JSON.parse(readFileSync(new URL('../glossary-allowlist.json', import.meta.url), 'utf8')) as AllowEntry[];

describe('the glossary lint', () => {
  it('reads the avoided terms from CONTEXT.md', () => {
    expect(terms).toEqual(expect.arrayContaining(['user', 'ai', 'tutor', 'bot', 'computer', 'accuracy', 'tip', 'drill', 'exercise', 'post-mortem']));
  });

  it('flags avoided terms in markup, attributes and messages', () => {
    const broken = [
      { file: 'Broken.svelte', source: '<script>let x = 1;</script>\n<h1>Ask the AI tutor</h1>\n<button aria-label="Play the bot">Go</button>' },
      { file: 'broken.ts', source: "throw new AppError('bad-request', 'Your accuracy was 80% in this drill.');" },
      { file: 'broken.html', source: '<style>.tip { color: red }</style>\n<p>Play the computer.</p>\n<script>const tip = "Ask the tutor";</script>' },
    ];
    const findings = lint(broken, terms, allow);
    expect(findings.map((f) => `${f.file}:${f.line}:${f.term}`)).toEqual([
      'Broken.svelte:2:tutor',
      'Broken.svelte:2:ai',
      'Broken.svelte:3:bot',
      'broken.ts:1:accuracy',
      'broken.ts:1:drill',
      'broken.html:2:computer',
    ]);
  });

  it('passes the glossary’s own words and allowed phrases', () => {
    const fine = [
      { file: 'Fine.svelte', source: '<h1>OpenChessCoach</h1>\n<p>The Coach explains the Engine’s Move Grade.</p>\n<p>Your rating on Lichess</p>' },
      { file: 'fine.ts', source: "const sql = 'SELECT user FROM t'; const id = 'user-agent';" },
    ];
    expect(lint(fine, terms, allow)).toEqual([]);
  });
});

describe('the Coach\'s instructions', () => {
  it('tell the Coach to avoid every term CONTEXT.md avoids, which the real-Coach check fails on', () => {
    const neverSay = SYSTEM_PROMPT.match(/Never say: ([^.]+)\./)?.[1] ?? '';
    const listed = new Set(neverSay.split(/,\s*/).map((t) => t.replace(/\s*\(.*\)$/, '').trim().toLowerCase()));
    expect(terms.filter((t) => !listed.has(t))).toEqual([]);
  });
});
