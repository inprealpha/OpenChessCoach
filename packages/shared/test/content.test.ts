// The ADR 0005 and 0008 data checks: every Lesson line legal, every adapted text and position
// credited, every Puzzle legal and belonging to its Lesson. Each check is proven to fail on a broken
// copy of real data.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decisions, validateLesson, type LessonData } from '../src/content/lessons.ts';
import { pickPuzzles, validatePuzzles, type PuzzleFile } from '../src/content/puzzles.ts';

const dataDir = new URL('../../../data/', import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, dataDir), 'utf8')) as T;
const index = read<{ id: string; kind: string; decisions: number }[]>('lessons/index.json');
const lessons = index.map((l) => read<LessonData>(`lessons/${l.id}.json`));
const byId = (id: string) => lessons.find((l) => l.id === id) as LessonData;
const puzzles = read<PuzzleFile>('puzzles.json');
const themePuzzles = read<PuzzleFile>('theme-puzzles.json');
const catalogue = Object.fromEntries(lessons.map((l) => [l.id, { tags: l.puzzleTags, themes: l.puzzleThemes }]));
const copy = <T>(x: T): T => structuredClone(x);

describe('Lesson data', () => {
  it('covers the openings, the Themes and the basic endgames', () => {
    const ids = (kind: string) => lessons.filter((l) => l.kind === kind).map((l) => l.id).sort();
    expect(ids('opening')).toEqual(['caro-kann', 'italian-game', 'london-system', 'queens-gambit', 'queens-gambit-declined', 'ruy-lopez', 'two-knights-defence']);
    expect(ids('theme')).toEqual(['back-rank-mate', 'discovered-attacks', 'forks', 'pins', 'removing-the-defender', 'skewers']);
    expect(ids('endgame')).toEqual(['king-and-pawn', 'queen-mate', 'rook-endgames', 'rook-mate']);
  });

  it.each(lessons.map((l) => [l.id, l] as const))('%s passes the data check', (_id, lesson) => {
    expect(validateLesson(lesson)).toEqual([]);
  });

  it('counts the decisions the catalogue shows', () => {
    for (const item of index) expect(decisions(byId(item.id)).length, item.id).toBe(item.decisions);
  });

  it('keeps the words the glossary avoids out of every text the Player reads', () => {
    const context = readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8');
    const avoided = context
      .split('\n')
      .flatMap((line) => line.match(/^_Avoid_:\s*(.+)$/)?.[1]?.split(',') ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const found: string[] = [];
    for (const l of lessons) {
      const texts = [l.intro.text, ...l.parts.flatMap((p) => [p.title, p.text ?? '', ...p.nodes.map((n) => n.notes?.text ?? '')])];
      for (const text of texts) {
        for (const term of avoided) if (new RegExp(`(?<![\\w-])${term}(?![\\w-])`, 'i').test(text)) found.push(`${l.id}: "${term}" in ${text.slice(0, 60)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('fails on an illegal main-line move', () => {
    const broken = copy(byId('italian-game'));
    (broken.parts[0] as { mainLine: string[] }).mainLine[3] = 'e1e5';
    expect(validateLesson(broken).join('\n')).toMatch(/main-line move 4 \(e1e5\) is not legal/);
  });

  it('fails on a note or intro without its credit', () => {
    const broken = copy(byId('italian-game'));
    const node = broken.parts[0]?.nodes.find((n) => n.decision && n.notes);
    if (!node?.notes) throw new Error('no notes');
    node.notes.credit = { ...node.notes.credit, licence: '' };
    expect(validateLesson(broken).join('\n')).toMatch(/notes are missing their credit/);
    const noIntroCredit = copy(byId('london-system'));
    noIntroCredit.intro.credit.url = 'https://example.com/';
    expect(validateLesson(noIntroCredit).join('\n')).toMatch(/intro is missing its credit/);
  });

  it('fails on a Theme position without its source, or with a line that does not start from it', () => {
    const broken = copy(byId('pins'));
    const [first, second] = broken.parts;
    if (!first || !second) throw new Error('needs two parts');
    first.credit = { ...first.credit, url: 'https://example.com/' };
    second.fen = first.fen;
    const problems = validateLesson(broken).join('\n');
    expect(problems).toMatch(/pins part 1: the position is missing its credit/);
    expect(problems).toMatch(/pins part 2: main-line move 1 \(\w+\) is not legal/);
  });

  it('fails on a popular move that is not legal', () => {
    const broken = copy(byId('queens-gambit'));
    broken.parts[0]?.nodes[0]?.popular.casual.push({ uci: 'a1a8', san: 'Ra8', percent: 1, games: 1 });
    expect(validateLesson(broken).join('\n')).toMatch(/popular move a1a8 \(casual\) is not legal/);
  });
});

describe('Puzzle data', () => {
  it.each([
    ['opening', puzzles],
    ['Theme and endgame', themePuzzles],
  ] as const)('the %s Puzzles pass the data check', (_name, file) => {
    expect(file.puzzles.length).toBeGreaterThanOrEqual(100);
    expect(validatePuzzles(file, catalogue)).toEqual([]);
  });

  it('gives every Lesson with Puzzle themes or tags its own Puzzles, and no Puzzle twice', () => {
    const all = [...puzzles.puzzles, ...themePuzzles.puzzles];
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const l of lessons.filter((x) => x.puzzleTags.length || x.puzzleThemes.length)) {
      expect(all.filter((p) => p.lessonId === l.id).length, l.id).toBeGreaterThanOrEqual(5);
    }
  });

  it('fails on an illegal move and on a Puzzle outside its Lesson', () => {
    const broken = copy(puzzles);
    const [first, second] = broken.puzzles;
    if (!first || !second) throw new Error('no puzzles');
    first.moves[1] = 'a1a1';
    second.openingTags = ['Sicilian_Defense'];
    second.themes = ['fork'];
    const problems = validatePuzzles(broken, catalogue).join('\n');
    expect(problems).toMatch(new RegExp(`Puzzle ${first.id}: move 2 \\(a1a1\\) is not legal`));
    expect(problems).toMatch(new RegExp(`Puzzle ${second.id}: none of its opening tags`));
  });

  it('picks Puzzles near the Player’s level and skips ones already done', () => {
    const [a, b] = pickPuzzles(puzzles.puzzles, 1300, { lessonId: 'caro-kann', count: 2 });
    expect(a?.lessonId).toBe('caro-kann');
    expect(Math.abs((a?.rating ?? 0) - 1300)).toBeLessThanOrEqual(Math.abs((b?.rating ?? 0) - 1300));
    const next = pickPuzzles(puzzles.puzzles, 1300, { lessonId: 'caro-kann', exclude: new Set([a?.id ?? '']), count: 1 });
    expect(next[0]?.id).toBe(b?.id);
  });
});
