// The deep Lesson check (data-prep/deep-check.ts, #28): which moves it judges with the tablebase,
// which moves a change adds, the tablebase client, and the Open files move the chess review found,
// which passed at the app's depths.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { playSan, turnOf } from '@chess-coach/shared/chess';
import { decisions, type LessonData, type LessonNode } from '@chess-coach/shared/content/lessons';
import { createNodeEngine } from '../../packages/backend/src/engine/node-engine.ts';
import { deepCheck, inTablebase, lichessTablebase, newDecisions, tablebaseVerdict, type Tablebase, type TablebaseAnswer } from '../../data-prep/deep-check.ts';

const read = (id: string) => JSON.parse(readFileSync(new URL(`../../data/lessons/${id}.json`, import.meta.url), 'utf8')) as LessonData;

/** A one-part Lesson from a SAN line, every move of `side` a decision. */
function lessonFrom(id: string, fen: string, line: string): LessonData {
  const side = turnOf(fen);
  const nodes: LessonNode[] = [];
  let at = fen;
  line.split(' ').forEach((san, ply) => {
    const played = playSan(at, san);
    if (!played) throw new Error(`illegal ${san}`);
    nodes.push({ ply, fen: at, decision: turnOf(at) === side, main: played.uci, mainSan: played.san, popular: { beginner: [], casual: [], club: [] } });
    at = played.fenAfter;
  });
  const part = { title: id, fen, side, keyIdea: '', credit: { source: '', url: '', licence: '', licenceUrl: '', authors: '' }, mainLine: nodes.map((n) => n.main), nodes };
  return { id, name: id, kind: 'thinking', track: 'thinking', level: 'intermediate', goal: '', priorKnowledge: [], side, puzzleTags: [], puzzleThemes: [], intro: { text: '' }, parts: [part] } as LessonData;
}

// White's king and rook against the king on b3: each move's category is Black's result after it.
const KRK = '8/8/8/8/8/1k6/8/R3K3 w - - 0 1';
const KRK_ANSWER: TablebaseAnswer = {
  category: 'win',
  moves: [
    { uci: 'e1d2', category: 'loss' },
    { uci: 'a1a8', category: 'loss' },
    { uci: 'a1a2', category: 'draw' },
  ],
};

describe('which positions the tablebase judges', () => {
  it('takes 7 pieces or fewer with no castling left', () => {
    expect(inTablebase(KRK)).toBe(true);
    expect(inTablebase('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1')).toBe(false);
    expect(inTablebase('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(false);
  });
});

describe('the tablebase verdict', () => {
  it('passes any move that keeps the win, however slow', () => {
    expect(tablebaseVerdict(KRK_ANSWER, 'e1d2')).toBeUndefined();
    expect(tablebaseVerdict(KRK_ANSWER, 'a1a8')).toBeUndefined();
  });

  it('fails a move that gives the win away', () => {
    expect(tablebaseVerdict(KRK_ANSWER, 'a1a2')).toBe('turns a win into a draw (tablebase)');
  });

  it('counts a win lost to the 50-move rule as a draw', () => {
    const answer: TablebaseAnswer = { category: 'win', moves: [{ uci: 'a1a8', category: 'loss' }, { uci: 'e1d2', category: 'blessed-loss' }] };
    expect(tablebaseVerdict(answer, 'e1d2')).toBe('turns a win into a draw (tablebase)');
  });

  it('passes every drawing move in a drawn position', () => {
    const answer: TablebaseAnswer = { category: 'draw', moves: [{ uci: 'a1a8', category: 'draw' }, { uci: 'e1d2', category: 'cursed-win' }, { uci: 'a1a2', category: 'win' }] };
    expect(tablebaseVerdict(answer, 'e1d2')).toBeUndefined();
    expect(tablebaseVerdict(answer, 'a1a2')).toBe('turns a draw into a loss (tablebase)');
  });

  it('leaves the move to the Engine when the tablebase doesn\'t know', () => {
    expect(tablebaseVerdict({ category: 'unknown', moves: [{ uci: 'a1a8', category: 'unknown' }] }, 'a1a8')).toBe('unknown');
    expect(tablebaseVerdict(KRK_ANSWER, 'a1h1')).toBe('unknown');
  });
});

describe('the moves a change adds', () => {
  const lesson = read('open-files');

  it('are every move of a new Lesson', () => {
    expect(newDecisions(lesson, undefined)).toHaveLength(decisions(lesson).length);
  });

  it('are none when only a note or a key idea changed', () => {
    const edited = structuredClone(lesson);
    const part = edited.parts[0];
    if (!part) throw new Error('no part');
    part.keyIdea = 'Something else';
    for (const node of part.nodes) if (node.notes) node.notes.text = 'Changed.';
    expect(newDecisions(edited, lesson)).toEqual([]);
  });

  it('are the moves in a line that changed', () => {
    const changed = structuredClone(lesson);
    const last = changed.parts[0]?.nodes.filter((n) => n.decision).at(-1);
    if (!last) throw new Error('no decision');
    Object.assign(last, { main: 'e1e2', mainSan: 'Re2' });
    expect(newDecisions(changed, lesson).map((d) => d.node.mainSan)).toEqual(['Re2']);
  });
});

describe('the Lichess tablebase client', () => {
  const ok = (body: TablebaseAnswer) => new Response(JSON.stringify({ ...body, dtz: 1, checkmate: false }), { status: 200 });
  const noWait = () => Promise.resolve();

  it('asks once for each position and keeps only what the check reads', async () => {
    const urls: string[] = [];
    const tablebase = lichessTablebase(async (url) => {
      urls.push(String(url));
      return ok(KRK_ANSWER);
    }, noWait);
    expect(await tablebase(KRK)).toEqual(KRK_ANSWER);
    await tablebase(KRK);
    expect(urls).toEqual([`https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(KRK)}`]);
  });

  it('tries again after an error, and waits a minute after a 429', async () => {
    const waits: number[] = [];
    const answers = [new Response('', { status: 429 }), new Response('', { status: 503 }), ok(KRK_ANSWER)];
    const tablebase = lichessTablebase(async () => answers.shift() as Response, async (ms) => void waits.push(ms));
    expect(await tablebase(KRK)).toEqual(KRK_ANSWER);
    expect(waits).toEqual([60_000, 4_000]);
  });

  it('gives up after five tries', async () => {
    const tablebase = lichessTablebase(async () => new Response('', { status: 503 }), noWait);
    await expect(tablebase(KRK)).rejects.toThrow(/didn't answer .* \(HTTP 503\)/);
  });
});

describe('the deep check', () => {
  const noTablebase: Tablebase = () => Promise.reject(new Error('no tablebase in this test'));

  it('fails the Open files move that passed at depths 10 and 14', async () => {
    // The line before the chess review cut it (#27): the last move, Rc6, is Good at the app's depths.
    const old = lessonFrom('open-files', '3r1rk1/p4pp1/1p1N2bp/3qP3/3P1Q2/P7/6PP/R3R1K1 w - - 1 25', 'Rac1 Rd7 Rc3 a6 Rec1 b5 Rc6');
    const rc6 = decisions(old).filter((d) => d.node.mainSan === 'Rc6');
    const failures = await deepCheck(await createNodeEngine(1), noTablebase, old, rc6);
    expect(failures).toEqual([expect.stringMatching(/^open-files part 1 Rc6 at depth 22: (Inaccuracy|Good, but too close to an Inaccuracy)/)]);
  });

  it('lets the tablebase pass a slower win the Engine would call a Mistake', async () => {
    // In Check's last part the Engine at depth 22 calls Kd8 a Mistake (Kb8 wins faster); a tablebase
    // that says Kd8 keeps the win passes it.
    const lesson = read('check');
    const kd8 = decisions(lesson).filter((d) => d.node.mainSan === 'Kd8' && inTablebase(d.node.fen));
    expect(kd8.length).toBeGreaterThan(0);
    const keepsWin: Tablebase = async (fen) => ({ category: 'win', moves: [{ uci: kd8.find((d) => d.node.fen === fen)?.node.main ?? '', category: 'loss' }] });
    expect(await deepCheck(await createNodeEngine(1), keepsWin, lesson, kd8)).toEqual([]);
  });
});
