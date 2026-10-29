// The ADR 0005, 0008 and 0012 data checks: every Lesson line legal, every position and kept text
// credited, every Lesson with its goal, prior knowledge and key ideas, every Puzzle legal and
// belonging to its Lesson. Each check is proven to fail on a broken copy of real data.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COURSE } from '../../../data-prep/course.ts';
import type { CatalogueItem } from '../src/content/course.ts';
import {
  checkPositionCredit,
  COURSE_LEVELS,
  decisions,
  keptOpenText,
  LICHESS_LICENCE,
  LICHESS_LICENCE_URL,
  priorKnowledgeCycles,
  TRACKS,
  validateLesson,
  type LessonData,
  type OpenText,
} from '../src/content/lessons.ts';
import { pickPuzzles, validatePuzzles, type PuzzleFile } from '../src/content/puzzles.ts';

const dataDir = new URL('../../../data/', import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, dataDir), 'utf8')) as T;
const index = read<CatalogueItem[]>('lessons/index.json');
const lessons = index.map((l) => read<LessonData>(`lessons/${l.id}.json`));
const byId = (id: string) => lessons.find((l) => l.id === id) as LessonData;
const puzzles = read<PuzzleFile>('puzzles.json');
const themePuzzles = read<PuzzleFile>('theme-puzzles.json');
const ids = new Set(lessons.map((l) => l.id));
const openTexts = read<{ texts: OpenText[] }>('open-texts.json').texts;
const catalogue = Object.fromEntries(lessons.map((l) => [l.id, { tags: l.puzzleTags, themes: l.puzzleThemes }]));
const copy = <T>(x: T): T => structuredClone(x);

describe('Lesson data', () => {
  it('lists every Lesson of the course, in the course order', () => {
    expect(index.map((l) => l.id)).toEqual(COURSE);
  });

  it('has Lessons at every level of every track', () => {
    for (const track of TRACKS) {
      for (const level of COURSE_LEVELS) expect(lessons.filter((l) => l.track === track && l.level === level).length, `${track} ${level}`).toBeGreaterThan(0);
    }
  });

  it.each(lessons.map((l) => [l.id, l] as const))('%s passes the data check', (_id, lesson) => {
    expect(validateLesson(lesson, ids)).toEqual([]);
    expect(keptOpenText(lesson, openTexts)).toEqual([]);
  });

  it('has no prior knowledge going round in a circle', () => {
    expect(priorKnowledgeCycles(lessons)).toEqual([]);
    const circle = [
      { id: 'a', priorKnowledge: ['b'] },
      { id: 'b', priorKnowledge: ['c'] },
      { id: 'c', priorKnowledge: ['a'] },
    ];
    expect(priorKnowledgeCycles(circle)).toEqual([['a', 'b', 'c', 'a']]);
  });

  it('suggests prior knowledge from earlier in the course', () => {
    const late: string[] = [];
    for (const l of lessons) for (const p of l.priorKnowledge) if (COURSE.indexOf(p) > COURSE.indexOf(l.id)) late.push(`${l.id} needs ${p}, which comes later`);
    expect(late).toEqual([]);
  });

  it('shows each Lesson in the catalogue as it is built', () => {
    for (const item of index) {
      const l = byId(item.id);
      expect(item, item.id).toEqual({
        id: l.id,
        name: l.name,
        kind: l.kind,
        track: l.track,
        level: l.level,
        side: l.side,
        ...(l.eco ? { eco: l.eco } : {}),
        goal: l.goal,
        priorKnowledge: l.priorKnowledge,
        decisions: decisions(l).length,
        ...(l.playOut ? { playOut: true } : {}),
      });
    }
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
      const texts = [l.name, l.goal, l.intro.text, ...l.parts.flatMap((p) => [p.title, p.keyIdea, p.text ?? '', ...p.nodes.map((n) => n.notes?.text ?? '')])];
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

  it('fails on a kept Wikibooks text without its credit, or a credit that is not CC BY-SA', () => {
    const kept = openTexts.find((t) => t.url.includes('Chess_Opening_Theory')) as OpenText;
    const broken = copy(byId('italian-game'));
    const node = broken.parts[0]?.nodes.find((n) => n.decision) as LessonData['parts'][number]['nodes'][number];
    node.notes = { text: `In short: ${kept.text}` };
    expect(keptOpenText(broken, openTexts).join('\n')).toMatch(/italian-game: part 1 ply \d+'s note keeps wording from https:\/\/en\.wikibooks\.org\//);
    node.notes = { text: kept.text, credit: { source: 'Wikibooks', url: kept.url, licence: '', licenceUrl: '', authors: 'x' } };
    expect(validateLesson(broken).join('\n')).toMatch(/the note's credit is not a Wikibooks or Wikipedia credit/);
  });

  it('fails on a key idea that names a move the Player has to find, in an opening too', () => {
    const broken = copy(byId('forks'));
    const part = broken.parts[0] as LessonData['parts'][number];
    const san = (part.nodes.find((n) => n.decision) as LessonData['parts'][number]['nodes'][number]).mainSan.replace(/[+#]$/, '');
    part.keyIdea = `Look for ${san} here.`;
    expect(validateLesson(broken).join('\n')).toMatch(new RegExp(`forks part 1: the key idea names a move the Player has to find \\(${san.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    const opening = copy(byId('italian-game'));
    (opening.parts[0] as { keyIdea: string }).keyIdea = 'Bring the bishop to c4 with Bc4.';
    expect(validateLesson(opening).join('\n')).toMatch(/italian-game: the key idea names a move the Player has to find \(Bc4\)/);
  });

  it('fails on a key idea that writes the move without its capture sign, or castles with zeros', () => {
    const named = (lesson: LessonData, keyIdea: string) => {
      const broken = copy(lesson);
      (broken.parts[0] as { keyIdea: string }).keyIdea = keyIdea;
      return validateLesson(broken).join('\n');
    };
    const decisionWith = (re: RegExp) => {
      const lesson = lessons.find((l) => l.parts[0]!.nodes.some((n) => n.decision && re.test(n.mainSan)))!;
      return { lesson, san: lesson.parts[0]!.nodes.find((n) => n.decision && re.test(n.mainSan))!.mainSan.replace(/[+#]$/, '') };
    };
    const capture = decisionWith(/^[KQRBN]x/);
    expect(named(capture.lesson, `Look for ${capture.san.replace('x', '')} here.`)).toContain(`the key idea names a move the Player has to find (${capture.san})`);
    const castling = decisionWith(/^O-O/);
    expect(named(castling.lesson, `Castle with ${castling.san.replace(/O/g, '0')} early.`)).toContain(`the key idea names a move the Player has to find (${castling.san})`);
  });

  it('fails on a kept text whose punctuation was changed, or kept in a title, key idea or goal', () => {
    const kept = openTexts.find((t) => t.text.split(' ').length > 20 && !/\d/.test(t.text)) as OpenText;
    const words = kept.text.split(' ').slice(0, 10);
    const broken = copy(byId('pins'));
    broken.goal = words.join('. ');
    expect(keptOpenText(broken, openTexts).join('\n')).toMatch(/pins: the name and goal keeps wording from/);
    broken.goal = 'You can pin a piece.';
    (broken.parts[0] as { keyIdea: string }).keyIdea = words.join('-');
    expect(keptOpenText(broken, openTexts).join('\n')).toMatch(/pins: part 1's title and key idea keeps wording from/);
  });

  it('fails on a Lesson without its goal, with unknown prior knowledge, or a part without its key idea', () => {
    const broken = copy(byId('forks'));
    broken.goal = ' ';
    broken.priorKnowledge = ['no-such-lesson'];
    (broken.parts[1] as { keyIdea: string }).keyIdea = '';
    (broken.parts[2] as { keyIdea: string }).keyIdea = 'x'.repeat(141);
    const problems = validateLesson(broken, ids).join('\n');
    expect(problems).toMatch(/forks: the Lesson has no learning goal/);
    expect(problems).toMatch(/forks: prior knowledge no-such-lesson is not a Lesson/);
    expect(problems).toMatch(/forks part 2: a part has no key idea/);
    expect(problems).toMatch(/forks part 3: the key idea is longer than 140 characters/);
  });

  it('fails on an unknown track or level, a kind in a track it does not belong to, or a Lesson that builds on itself', () => {
    const check = (id: string, change: (l: LessonData) => void) => {
      const broken = copy(byId(id));
      change(broken);
      return validateLesson(broken, ids).join('\n');
    };
    expect(check('forks', (l) => ((l as { track: string }).track = 'tactics'))).toMatch(/forks: unknown track tactics/);
    expect(check('forks', (l) => (l.track = 'endgames'))).toMatch(/forks: a theme Lesson cannot sit in the endgames track/);
    expect(check('piece-values', (l) => (l.track = 'themes'))).toMatch(/piece-values: a thinking Lesson cannot sit in the themes track/);
    expect(check('forks', (l) => ((l as { level: string }).level = 'advanced'))).toMatch(/forks: unknown level advanced/);
    expect(check('forks', (l) => (l.priorKnowledge = ['forks']))).toMatch(/forks: a Lesson cannot be its own prior knowledge/);
  });

  it('holds a learning goal to 240 characters and a key idea to one line of 140', () => {
    const check = (change: (l: LessonData) => void) => {
      const broken = copy(byId('forks'));
      change(broken);
      return validateLesson(broken, ids).join('\n');
    };
    expect(check((l) => (l.goal = 'g'.repeat(240)))).not.toMatch(/learning goal/);
    expect(check((l) => (l.goal = 'g'.repeat(241)))).toMatch(/forks: the learning goal is longer than 240 characters/);
    expect(check((l) => ((l.parts[0] as { keyIdea: string }).keyIdea = 'k'.repeat(140)))).not.toMatch(/part 1: the key idea/);
    expect(check((l) => ((l.parts[0] as { keyIdea: string }).keyIdea = 'One idea.\nAnother.'))).toMatch(/forks part 1: the key idea must be one line/);
  });

  it('fails on a kept intro or part text whose credit is not a Wikibooks or Wikipedia one', () => {
    const broken = copy(byId('forks'));
    const notWikibooks = { source: 'Wikibooks', url: 'https://example.com/', licence: 'CC BY-SA 4.0', licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', authors: 'a' };
    broken.intro.credit = notWikibooks;
    (broken.parts[0] as LessonData['parts'][number]).textCredit = { ...notWikibooks, url: 'https://en.wikibooks.org/wiki/Chess/Tactics', licence: '' };
    const problems = validateLesson(broken).join('\n');
    expect(problems).toMatch(/forks: the intro's credit is not a Wikibooks or Wikipedia credit/);
    expect(problems).toMatch(/forks part 1: the text's credit is not a Wikibooks or Wikipedia credit/);
  });

  it('counts 8 words in a row from an earlier open text as kept wording in an intro or a part text, and 7 as not', () => {
    // An open text that starts with 8 plain words, put between words of no text.
    const kept = openTexts.find((t) => t.text.split(' ').slice(0, 8).every((w) => /^[A-Za-z]+[,;]?$/.test(w))) as OpenText;
    const run = (n: number) => `Zzz zzz. ${kept.text.split(' ').slice(0, n).join(' ')} zzz.`;
    const withText = (n: number, where: 'intro' | 'part') => {
      const broken = copy(byId('pins'));
      if (where === 'intro') broken.intro.text = run(n);
      else (broken.parts[0] as { text: string }).text = run(n);
      return keptOpenText(broken, openTexts).join('\n');
    };
    const url = kept.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(withText(8, 'intro')).toMatch(new RegExp(`pins: the intro keeps wording from ${url} without its credit`));
    expect(withText(7, 'intro')).not.toMatch(/the intro keeps wording/);
    expect(withText(8, 'part')).toMatch(new RegExp(`pins: part 1's text keeps wording from ${url}`));
    expect(withText(7, 'part')).not.toMatch(/part 1's text keeps wording/);
  });

  it('takes a position from a Lichess puzzle or game, or the chess-openings list, and not from another Lichess page', () => {
    const credit = (url: string) => ({ source: 'Lichess games database', url, licence: LICHESS_LICENCE, licenceUrl: LICHESS_LICENCE_URL, authors: 'Lichess players' });
    for (const url of ['https://lichess.org/training/F1Ury', 'https://lichess.org/AbCd1234', 'https://lichess.org/AbCd1234#12', 'https://github.com/lichess-org/chess-openings']) {
      expect(checkPositionCredit(credit(url)), url).toBe(true);
    }
    for (const url of ['https://lichess.org/training', 'https://lichess.org/analysis', 'https://lichess.org/practice', 'https://lichess.org/abcdefgh/black', 'https://lichess.org/study/AbCd1234']) {
      expect(checkPositionCredit(credit(url)), url).toBe(false);
    }
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
