// The Engine check (ADR 0008, ADR 0012): every move the Player is asked to find in a Lesson must be
// graded Best or Good by the Engine, at the depth verify mode grades at and at the desktop's depth,
// so a Player who plays the move the Lesson teaches is never told it is an Inaccuracy or worse. Run
// it after changing any Lesson line, passing the ids you changed (all 64 Lessons at both depths take
// many minutes). npm test runs it at depth 10 on every Lesson. Exits 1 and lists the moves that fail.
//
// --deep runs the deep check of deep-check.ts instead: depth 22 with headroom below an Inaccuracy,
// and the Lichess tablebase in endgames of 7 pieces or fewer (it needs the network). It takes about
// half a minute a move, so CI runs it only on the moves a PR adds (--changed-since=<the PR's base>).
//
// Usage: node data-prep/engine-check.ts [lesson-id ...] [--depth=10,14]
//        node data-prep/engine-check.ts --deep [lesson-id ...] [--changed-since=<git ref>] [--depth=22]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decisions, engineCheck, type LessonData } from '@chess-coach/shared/content/lessons';
import { createNodeEngine } from '../packages/backend/src/engine/node-engine.ts';
import { deepCheck, DEEP_DEPTH, lichessTablebase, newDecisions } from './deep-check.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const deep = args.includes('--deep');
const since = flag('changed-since');
const depths = (flag('depth') ?? (deep ? String(DEEP_DEPTH) : '10,14')).split(',').map(Number);
const only = args.filter((a) => !a.startsWith('--'));
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const ids = read<{ id: string }[]>('../data/lessons/index.json').map((l) => l.id).filter((id) => !only.length || only.includes(id));

/** A Lesson as built at a git commit, or undefined when it didn't exist there. */
function lessonAt(ref: string, id: string): LessonData | undefined {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:data/lessons/${id}.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as LessonData;
  } catch {
    return undefined;
  }
}

const engine = await createNodeEngine(1);
const tablebase = lichessTablebase();
const failures: string[] = [];
let checked = 0;
for (const id of ids) {
  const lesson = read<LessonData>(`../data/lessons/${id}.json`);
  if (deep) {
    const list = since ? newDecisions(lesson, lessonAt(since, id)) : decisions(lesson);
    if (!list.length) continue;
    for (const depth of depths) failures.push(...(await deepCheck(engine, tablebase, lesson, list, depth)));
    checked += list.length;
    console.error(`${id}: ${list.length} move(s) checked`);
  } else {
    for (const depth of depths) failures.push(...(await engineCheck(engine, lesson, depth)));
    checked += decisions(lesson).length;
    console.error(`${id}: checked`);
  }
}
if (failures.length) {
  console.error(`\n${failures.length} move(s) failed${deep ? ' the deep check' : ', graded worse than Good'}:\n${failures.join('\n')}`);
  if (deep) console.error('\nCut the line before the move, or show the move instead of asking for it (ADR 0008), then run node data-prep/lessons.ts.');
  process.exit(1);
}
if (deep && since && !checked) console.error(`No Lesson move changed since ${since}: nothing for the deep check.`);
else if (deep) console.error(`\n${checked} Lesson move(s) pass the deep check at depth ${depths.join(' and ')}, with the tablebase in endgames.`);
else console.error(`\nEvery Player move in ${ids.length} Lessons is Best or Good at depth ${depths.join(' and ')}.`);
process.exit(0);
