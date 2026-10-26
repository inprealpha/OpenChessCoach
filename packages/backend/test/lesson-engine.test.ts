// The ADR 0008 Engine check on every Lesson, at the depth verify mode grades at, on the desktop's
// Engine that grades Lesson moves in the app (ADR 0007). The Lesson journeys walk one Lesson of each
// kind in the browser; this covers every decision of every Lesson. data-prep/engine-check.ts adds
// the desktop's depth.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { engineCheck, type LessonData } from '@chess-coach/shared/content/lessons';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../../../data/lessons/${path}`, import.meta.url), 'utf8')) as T;
const lessons = read<{ id: string }[]>('index.json').map(({ id }) => read<LessonData>(`${id}.json`));

describe('the Engine check', () => {
  it.each(lessons.map((l) => [l.id, l] as const))('grades every move %s asks for Best or Good', async (_id, lesson) => {
    expect(await engineCheck(await createNodeEngine(1), lesson, VERIFY_ENGINE.depth)).toEqual([]);
  });

  it('fails on a move that loses a piece', async () => {
    const broken = structuredClone(lessons.find((l) => l.id === 'italian-game') as LessonData);
    const node = broken.parts[0]?.nodes.find((n) => n.decision && n.main === 'f1c4');
    if (!node) throw new Error('no Bc4 decision');
    Object.assign(node, { main: 'f1a6', mainSan: 'Ba6' });
    const failures = await engineCheck(await createNodeEngine(1), broken, VERIFY_ENGINE.depth);
    expect(failures).toEqual([expect.stringMatching(/^italian-game part 1 Ba6 at depth 10: (Inaccuracy|Mistake|Blunder)$/)]);
  });
});
