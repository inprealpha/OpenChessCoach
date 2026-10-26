// The glossary lint is trusted only after it fails on a deliberately broken input.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBrief } from '@chess-coach/shared/coach/brief';
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
  it('name only the few avoided terms the Coach reaches for, each with what to say instead', () => {
    // A long list buries the words that matter; the real-Coach check warns on the rest anyway.
    const neverSay = SYSTEM_PROMPT.match(/Never say: ([^.]+)\./)?.[1] ?? '';
    const entries = neverSay.split(/;\s*/).map((e) => /^(.+?) \(say (.+)\)$/.exec(e.trim().replace(/\s+/g, ' ')));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(8);
    for (const entry of entries) {
      expect(entry, 'each entry reads "<term(s)> (say <what instead>)"').not.toBeNull();
      for (const term of (entry?.[1] ?? '').split(/ or /)) expect(terms, `"${term}" is an avoided term in CONTEXT.md`).toContain(term.toLowerCase());
    }
    expect(neverSay).toMatch(/\bscore\b/);
  });

  it('name the brief’s fields without the terms CONTEXT.md avoids, since the Coach reads them', () => {
    // Every field at once: a Why Question with a move, replies and Lesson notes.
    const brief = buildBrief({
      ask: {
        job: 'why',
        fen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        recentMoves: ['e4', 'd5'],
        playerSide: 'white',
        move: { uci: 'g1f3', san: 'Nf3', grade: 'Blunder', playedScore: { cp: -120 } },
        candidates: [{ uci: 'e4d5', san: 'exd5', score: { cp: 40 }, pv: ['e4d5', 'd8d5'] }],
        replies: [{ uci: 'd5e4', san: 'dxe4', score: { cp: 120 }, pv: ['d5e4'] }],
        question: 'Why not Nf3?',
        lesson: { lessonId: 'scandinavian', opening: 'Scandinavian Defence', notes: 'Take back on d5.', popularity: [{ san: 'exd5', percent: 80 }], finalTurn: true },
        opening: 'Scandinavian Defence',
      },
      profile: { level: 'casual', rating: 1450, goals: ['Learn the Scandinavian Defence'], weaknesses: [], notes: [] },
      summary: 'Player asked about d5.',
    });
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
      }
    };
    walk(brief);
    expect([...keys]).toEqual(expect.arrayContaining(['winningChances', 'candidates', 'replies', 'lesson', 'profile']));
    // `rating` is the Player's rating from another site, which the glossary allowlist allows.
    const words = [...keys].filter((k) => k !== 'rating').map((k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
    expect(words.flatMap((w) => terms.filter((t) => new RegExp(`\\b${t}s?\\b`).test(w)).map((t) => `${w}: ${t}`))).toEqual([]);
  });
});
