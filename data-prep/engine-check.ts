// The Engine check (ADR 0008): every move the Player is asked to find in a Lesson must be graded
// Best or Good by the Engine, at the depth verify mode grades at and at the desktop's depth, so a
// Player who plays the book move is never told it is an Inaccuracy or worse. Run it after changing
// any Lesson line, passing the ids you changed (all 17 at both depths take a few minutes). npm test
// runs it at depth 10 on every Lesson. Exits 1 and lists the moves that fail.
//
// Usage: node data-prep/engine-check.ts [lesson-id ...] [--depth=10,14]
import { readFileSync } from 'node:fs';
import { engineCheck, type LessonData } from '@chess-coach/shared/content/lessons';
import { createNodeEngine } from '../packages/backend/src/engine/node-engine.ts';

const args = process.argv.slice(2);
const depths = (args.find((a) => a.startsWith('--depth='))?.slice(8) ?? '10,14').split(',').map(Number);
const only = args.filter((a) => !a.startsWith('--'));
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const ids = read<{ id: string }[]>('../data/lessons/index.json').map((l) => l.id).filter((id) => !only.length || only.includes(id));

const engine = await createNodeEngine(1);
const failures: string[] = [];
for (const id of ids) {
  const lesson = read<LessonData>(`../data/lessons/${id}.json`);
  for (const depth of depths) failures.push(...(await engineCheck(engine, lesson, depth)));
  console.error(`${id}: checked`);
}
if (failures.length) {
  console.error(`\n${failures.length} move(s) graded worse than Good:\n${failures.join('\n')}`);
  process.exit(1);
}
console.error(`\nEvery Player move in ${ids.length} Lessons is Best or Good at depth ${depths.join(' and ')}.`);
process.exit(0);
