// The simple claims in every Lesson's notes, checked against the board (issue #37): material counts,
// "X guards Y" and "the only legal move". note-claims.ts lists the phrasings it reads; "the only move
// that holds" needs the Engine and is checked in packages/backend/test/lesson-note-holds.test.ts.
// Each kind of claim has golden tests that break a real note, so the checker can't pass everything.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../src/chess.ts';
import type { LessonData } from '../src/content/lessons.ts';
import { noteClaims, type NoteClaim } from './note-claims.ts';

const dataDir = new URL('../../../data/', import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, dataDir), 'utf8')) as T;
const lessons = read<{ id: string }[]>('lessons/index.json').map(({ id }) => read<LessonData>(`lessons/${id}.json`));
const byId = (id: string) => lessons.find((l) => l.id === id) as LessonData;

/**
 * Claims the checker finds false in today's Lessons, kept until the owner fixes the Lesson text
 * (changed Lesson text needs the owner's comparison with the private books, ADR 0012). Each entry is
 * "<lesson id> part <n> <where>: <the claim's words>", with a comment saying why it is false. A claim
 * the checker reads wrongly is a checker bug: fix note-claims.ts instead of listing it here.
 *
 * Empty: when this check was added (issue #37), and again when the review widened what it reads,
 * every claim it reads in today's Lessons was true.
 */
const KNOWN_FALSE: readonly string[] = [];

const all = lessons.flatMap((l) => noteClaims(l).claims);
const label = (c: NoteClaim) => `${c.at}: ${c.phrase}`;

/** The false claims of `lesson` after replacing `from` with `to` in the note at `at` ("text" or a main-line move's SAN). */
function broken(id: string, part: number, at: string, from: string, to: string): NoteClaim[] {
  const lesson = structuredClone(byId(id));
  const p = lesson.parts[part - 1];
  if (!p) throw new Error(`${id} has no part ${part}`);
  const holder = at === 'text' ? p : p.nodes.find((n) => n.mainSan === at)?.notes;
  if (!holder?.text?.includes(from)) throw new Error(`${id} part ${part} ${at}: no "${from}" in its note`);
  holder.text = holder.text.replace(from, to);
  return noteClaims(lesson).claims.filter((c) => c.problem);
}

/** A one-part Lesson from `fen` whose part text is `text`, the Player playing `side`, the line `main`. */
function lessonAt(fen: string, text: string, main = 'e2e4', side: 'white' | 'black' = 'white'): LessonData {
  return {
    id: 'golden',
    parts: [{ title: 'golden', fen, side, text, keyIdea: '', credit: {}, mainLine: [main], nodes: [{ ply: 0, fen, decision: true, main, mainSan: '', popular: {} }] }],
  } as unknown as LessonData;
}
const problems = (lesson: LessonData) => noteClaims(lesson).claims.map((c) => c.problem);

/** The same, with `note` as the note on the part's one move rather than as the part's text. */
function noteOn(fen: string, main: string, note: string): LessonData {
  const lesson = lessonAt(fen, '', main);
  const part = lesson.parts[0] as LessonData['parts'][number];
  delete part.text;
  (part.nodes[0] as LessonData['parts'][number]['nodes'][number]).notes = { text: note };
  return lesson;
}

describe('the claims in Lesson notes', () => {
  it('reads enough claims of each kind for the check to mean something', () => {
    const count = (kind: NoteClaim['kind']) => all.filter((c) => c.kind === kind).length;
    expect(count('material')).toBeGreaterThanOrEqual(70);
    expect(count('guards')).toBeGreaterThanOrEqual(130);
    expect(count('only-move')).toBeGreaterThanOrEqual(20);
  });

  it('skips only a few claims it matches but cannot pin down, and says which', () => {
    // A skipped claim is neither passed nor failed; a jump here means a phrasing stopped reading.
    const skipped = lessons.flatMap((l) => noteClaims(l).skipped);
    expect(skipped.length).toBeLessThanOrEqual(6);
    for (const s of skipped) expect(s.why).toMatch(/^(names a piece without its side or square, and both sides have one|a list the phrasings read only part of|a piece the phrasings cannot place)$/);
  });

  it.each(lessons.map((l) => [l.id, l] as const))('%s: every claim its notes make is true on the board', (id, lesson) => {
    const known = KNOWN_FALSE.filter((k) => k.startsWith(`${id} `));
    const found = noteClaims(lesson).claims.filter((c) => c.problem);
    expect(found.filter((c) => !known.includes(label(c))).map((c) => `${label(c)} (${c.problem})`)).toEqual([]);
    // A fixed claim leaves the list too, so it can't hide a new error with the same words.
    expect(known.filter((k) => !found.some((c) => label(c) === k))).toEqual([]);
  });
});

describe('material counts', () => {
  it('fails on a wrong count of points', () => {
    expect(broken('forks', 2, 'Bxc3', 'are now 3 ahead', 'are now 4 ahead')).toEqual([
      { kind: 'material', at: 'forks part 2 Bxc3', phrase: '4 ahead', problem: 'white is 3 up, not 4 up' },
    ]);
  });

  it('fails on a wrong count told in the past', () => {
    expect(broken('forks', 2, 'Bxc3', 'You were 2 points behind', 'You were 3 points behind').map((c) => c.problem)).toEqual(['white is 2 down, not 3 down']);
  });

  it('fails on pawns up that are not', () => {
    expect(broken('defending', 1, 'Qxd4', 'you are two pawns up', 'you are a pawn up').map((c) => c.problem)).toEqual(['white is 2 up, not 1 up']);
  });

  it('fails on the exchange the wrong way round', () => {
    expect(broken('defending', 4, 'text', 'the exchange up', 'the exchange down').map((c) => c.problem)).toEqual(['white is 2 up, not 2 down']);
  });

  it('fails on material called level that is not', () => {
    expect(broken('forks', 2, 'text', 'You are White, 2 points behind', 'You are White, and the material is level').map((c) => c.problem)).toEqual([
      'White is 2 down, not level',
    ]);
  });

  it('reads whose count it is and a piece down for a pawn', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'Black is a pawn up.'))).toEqual(['black is level, not 1 up']);
    expect(problems(lessonAt('4k3/8/8/8/8/8/P7/4K1N1 w - - 0 1', 'You are a knight and a pawn up.', 'e1d1'))).toEqual([undefined]);
    expect(problems(lessonAt('4k1n1/8/8/8/8/8/P7/4K3 w - - 0 1', 'You are 2 points behind: a knight down for a pawn.', 'e1d1'))).toEqual([undefined, undefined]);
    expect(problems(lessonAt('4k1n1/8/8/8/8/8/P7/4K3 w - - 0 1', 'You are a knight down.', 'e1d1'))).toEqual(['white is 2 down, not 3 down']);
  });
});

describe('X guards Y', () => {
  it('fails on a square the piece does not reach', () => {
    expect(broken('forks', 2, 'Bf6+', 'your rook on b6 guards f6', 'your rook on b6 guards f7')).toEqual([
      { kind: 'guards', at: 'forks part 2 Bf6+', phrase: 'your rook on b6 guards f7', problem: 'the white rook on b6 does not reach f7' },
    ]);
  });

  it('fails on a piece that is not where the note says', () => {
    expect(broken('forks', 4, 'text', "White's knight on c3 guards", "White's knight on d2 guards").map((c) => c.problem)).toEqual(['there is no white knight on d2']);
  });

  it('fails on a piece guarded that is not attacked', () => {
    expect(broken('queen-mate', 1, 'text', 'guards the whole fifth rank', 'guards the whole sixth rank').map((c) => c.problem)).toEqual([
      'the white queen on a5 does not reach c6, d6, e6, f6, g6, h6',
    ]);
  });

  it('fails on "guards" a piece of the other side, and "attacks" one of its own', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'Your knight on g1 guards f3, and your knight on g1 defends the pawn on g2.'))).toEqual([undefined, 'the white knight on g1 does not attack g2']);
    expect(problems(lessonAt(INITIAL_FEN, "Your pawn on e2 guards Black's queen."))).toEqual(["the black queen is not white's"]);
    expect(problems(lessonAt('4k3/8/8/8/8/5p2/4P3/4K3 w - - 0 1', 'Your pawn on e2 attacks the pawn on f3, and the pawn on e2 attacks your king.', 'e1d1'))).toEqual([
      undefined,
      "the white king is white's own",
    ]);
  });

  it('fails on "only" when another piece guards it too, and on "nothing guards" a guarded piece', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'Your knight on g1 guards f3.'))).toEqual([undefined]);
    expect(problems(lessonAt(INITIAL_FEN, 'Only your knight on g1 guards f3.'))).toEqual(['e2, g2 also guard f3']);
    expect(broken('checks-captures-threats', 2, 'Qxh8', 'Nothing guards the rook on h8 now', 'Nothing guards the rook on f7 now').map((c) => c.problem)).toEqual(['e7 guard f7']);
  });
});

describe('the only legal move', () => {
  it('fails on a move called the only legal one that is not', () => {
    expect(broken('forks', 2, 'Bxc3', 'You were 2 points behind', 'Bxc3 is the only legal move. You were 2 points behind').map((c) => c.problem)).toEqual([
      expect.stringMatching(/^\d+ legal moves where Bxc3 is played$/),
    ]);
  });

  it('passes on a real one, and fails when the note names the wrong move', () => {
    expect(problems(lessonAt('8/8/8/8/6k1/5q2/6KR/8 w - - 24 85', '85.Kg1 is the only legal move.', 'g2g1'))).toEqual([undefined]);
    expect(broken('draws', 2, 'Kg1', '85.Kg1 is the only legal move', '85.Kh1 is the only legal move').map((c) => c.problem)).toEqual(['Kh1 is not in the line']);
  });

  it("fails on a side's only move, and on the king's only square", () => {
    expect(broken('mate-in-two', 1, 'Re8+', "the king's only move is to g7", "the king's only move is to h7").map((c) => c.problem)).toEqual(['the king can go to g7']);
    expect(problems(lessonAt(INITIAL_FEN, "1.e4 is White's only move."))).toEqual(['20 legal moves where e4 is played']);
    expect(problems(lessonAt(INITIAL_FEN, "That leaves 1.e4 as White's only legal move."))).toEqual(['20 legal moves where e4 is played']);
  });
});

// The break-it pass on the checker (build-a-feature skill, section 5): notes it missed or misread
// until it was fixed, each kept as a test.
describe('notes the checker once got wrong', () => {
  it('counts a pinned piece as guarding no piece off its pin line, as the Coach does', () => {
    // The knight on d2 is pinned to the king on e1 by the bishop on b4, so it cannot take back on e4.
    const pinned = '4k3/8/8/8/1b2P3/8/3N4/4K3 w - - 0 1';
    expect(problems(lessonAt(pinned, 'Your knight on d2 defends the pawn on e4.', 'e1f1'))).toEqual([
      'the white knight on d2 could not take back on e4',
    ]);
    // It still covers squares: the other side's king can't go where a pinned piece attacks.
    expect(problems(lessonAt(pinned, 'Your knight on d2 covers e4 and f3.', 'e1f1'))).toEqual([undefined]);
  });

  it('reads "now guards" in a move\'s note as the board after the move', () => {
    expect(problems(noteOn(INITIAL_FEN, 'g1f3', 'Your knight on g1 now guards f3.'))).toEqual(['there is no white knight on g1']);
    expect(problems(noteOn(INITIAL_FEN, 'g1f3', 'Your knight on f3 now guards e5.'))).toEqual([undefined]);
  });

  it('reads a move with "!" or "?" after it, and curly apostrophes', () => {
    expect(problems(lessonAt(INITIAL_FEN, '1.e4! is the only legal move.'))).toEqual(['20 legal moves where e4 is played']);
    expect(problems(lessonAt(INITIAL_FEN, '1.e4 is White’s only move.'))).toEqual(['20 legal moves where e4 is played']);
    expect(problems(lessonAt(INITIAL_FEN, 'You’re a pawn up.'))).toEqual(['white is level, not 1 up']);
  });

  it('reads capitals, and counts a promotion in the board after the move', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'THE MATERIAL IS LEVEL. Black Is A Pawn Up.'))).toEqual([undefined, 'black is level, not 1 up']);
    expect(problems(noteOn('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8q', 'You are a pawn up.'))).toEqual(['white is 9 up, not 1 up']);
  });

  it('leaves "the only answer" with more than one legal reply to the Engine, not to a pass', () => {
    const lesson = lessonAt('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', "Black's only answer is to push the e-pawn.", 'e7e5', 'black');
    expect(noteClaims(lesson)).toEqual({ claims: [], skipped: [], holds: [expect.objectContaining({ uci: 'e7e5' })] });
  });
});

// The independent review of the first version: each finding it confirmed, kept as a test.
describe('the review findings', () => {
  it('B: counts a king as defending only where it can take back, as the Coach does', () => {
    // After ...Rxd5 the bishop on a8 still covers d5, so the king on e4 cannot take back.
    const fen = 'b2r3k/8/8/3P4/4K3/8/8/8 w - - 0 1';
    expect(problems(lessonAt(fen, 'Your king on e4 defends the pawn on d5.', 'e4e3'))).toEqual(['the white king on e4 could not take back on d5']);
    // Without the bishop it can.
    expect(problems(lessonAt('3r3k/8/8/3P4/4K3/8/8/8 w - - 0 1', 'Your king on e4 defends the pawn on d5.', 'e4e3'))).toEqual([undefined]);
  });

  it("C: takes a count's subject from a subject, not from a colour in front of a noun", () => {
    const fen = '4k3/p7/8/8/8/8/8/4K3 w - - 0 1';
    expect(problems(lessonAt(fen, 'You attacked the black king and are a pawn up.', 'e1d1'))).toEqual(['white is 1 down, not 1 up']);
    expect(problems(lessonAt(fen, 'You attacked the Black pieces, and Black is a pawn up.', 'e1d1'))).toEqual([undefined]);
  });

  it('D: checks every piece of "X and Y both attack Z", and every target of "guards A and B"', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'Your rook and your queen on d1 both attack d2.'))).toEqual(['the white rook on a1 does not reach d2']);
    expect(problems(lessonAt(INITIAL_FEN, 'Your knight on g1 guards f3 and g2.'))).toEqual(['the white knight on g1 does not reach g2']);
    // "the queen" without a side takes the side its target implies.
    expect(problems(lessonAt(INITIAL_FEN, 'The queen attacks your pawn on d2.'))).toEqual(['the black queen on d8 does not attack d2']);
  });

  it('E: skips only the hypothetical clause of a sentence', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'You are a rook up, so if Black waits you win.'))).toEqual(['white is level, not 5 up']);
    expect(problems(lessonAt(INITIAL_FEN, 'The king could not escape to f7, because your knight on g1 guards f3.'))).toEqual([undefined]);
    // The real one the review found stays unchecked: what explains an imagined position is imagined too.
    expect(problems(lessonAt(INITIAL_FEN, 'Bxc6 would only trade bishop for knight, and you would still be a piece down.'))).toEqual([]);
    expect(problems(lessonAt(INITIAL_FEN, '4.Qxf7 would be checkmate, because your bishop on c1 guards the queen.'))).toEqual([]);
  });

  it('G: fails on "It is the only legal move" when it is not, and on a battery read as one piece', () => {
    expect(problems(noteOn(INITIAL_FEN, 'e2e4', 'It is the only legal move.'))).toEqual(['20 legal moves where e4 is played']);
    expect(problems(noteOn(INITIAL_FEN, 'e2e4', 'The only legal move: the pawn goes two squares.'))).toEqual(['20 legal moves where e4 is played']);
    expect(problems(lessonAt('4k3/8/8/8/8/8/3R4/3QK3 w - - 0 1', 'Your queen on d1 guards d5.', 'e1f1'))).toEqual(['the white queen on d1 does not reach d5']);
  });

  it('reads a move with its number as that move, not a later one with the same name', () => {
    // blunder-check part 1: "after 10...exd4" is the move Black doesn't get to play, not the line's 11...exd4.
    expect(noteClaims(byId('blunder-check')).claims.filter((c) => /bishop on e3/.test(c.phrase))).toEqual([]);
  });

  it('reads "any other move loses" as an Engine claim, about the reply when the other side "has to" move', () => {
    const decoy = noteClaims(byId('decoy')).holds.find((h) => h.at === 'decoy part 1 Rxg7');
    expect(decoy).toMatchObject({ phrase: 'any other move allows mate', uci: 'h8g7' });
    const { holds } = noteClaims(noteOn(INITIAL_FEN, 'e2e4', 'Any other move loses.'));
    expect(holds).toEqual([expect.objectContaining({ fen: INITIAL_FEN, uci: 'e2e4' })]);
  });
});

describe('the phrasings added after the review', () => {
  it('fails on "is guarded by" and "guarded by" claims that are false', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'The pawn on e2 is guarded by your knight on g1.'))).toEqual([undefined]);
    expect(problems(lessonAt(INITIAL_FEN, 'The pawn on e2 is guarded by your bishop on c1.'))).toEqual(['the white bishop on c1 does not attack e2']);
    expect(problems(lessonAt(INITIAL_FEN, 'Your pawn on e2, guarded by the knight on b1, stays.'))).toEqual(['the white knight on b1 does not attack e2']);
    expect(broken('opening-principles', 4, 'Be2', "c7 is guarded by Black's queen", "c7 is guarded by Black's knight on c6").map((c) => c.problem)).toEqual([
      'there is no black knight on c6',
    ]);
  });

  it('fails on a plural subject that does not all guard the square', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'Your pawns on c2 and e2 guard d3.'))).toEqual([undefined]);
    expect(problems(lessonAt(INITIAL_FEN, 'Your pawns on e2 and d2 guard d3.'))).toEqual(['the white pawn on d2 does not reach d3']);
    expect(broken('weak-pawns', 3, 'text', 'your pawns on b4 and d4 guard c5', 'your pawns on b4 and d4 guard e5').map((c) => c.problem)).toEqual([
      'the white pawn on b4 does not reach e5',
    ]);
  });

  it('fails on "guards it there" when nothing guards the moved piece where it lands', () => {
    expect(problems(noteOn(INITIAL_FEN, 'g1f3', 'Your pawn on e2 guards it there.'))).toEqual([undefined]);
    expect(problems(noteOn(INITIAL_FEN, 'g1f3', 'Your pawn on d2 guards it there.'))).toEqual(['the white pawn on d2 does not attack f3']);
    expect(problems(noteOn(INITIAL_FEN, 'g1f3', 'The knight goes to f3, where your bishop on c1 protects it.'))).toEqual(['the white bishop on c1 does not attack f3']);
  });

  it('fails on "no white piece guards" and "nothing defends" when something does', () => {
    expect(problems(lessonAt(INITIAL_FEN, 'No white piece guards e4.'))).toEqual([undefined]);
    expect(problems(lessonAt(INITIAL_FEN, 'No white piece guards e3.'))).toEqual(['d2, f2 attack e3']);
  });

  it('fails on a wrong only square, safe square, and "its only move is to take"', () => {
    expect(problems(noteOn('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8', "The king's only square is e7."))).toEqual(['the king can go to d7, e7, f7']);
    expect(broken('trapped-pieces', 3, 'Ra1', "The queen's only safe square is b2", "The queen's only safe square is a2").map((c) => c.problem)).toEqual([
      'the queen can go safely to b2',
    ]);
    // The note's own knight move: e7 is its only safe square, not its only square.
    expect(broken('attack-and-defend', 1, 'Ne7', 'e7 is the only safe square', 'e7 is the only square').map((c) => c.problem)).toEqual([
      'the knight can go to f6, h6, e7',
    ]);
    expect(problems(noteOn(INITIAL_FEN, 'e2e4', 'Its only move is to take the pawn.'))).toEqual(['no black piece has taking the pawn as its only move']);
  });

  it('fails on "ahead in material", "an extra knight" and "the pawns are level" when they are not', () => {
    expect(broken('when-to-trade', 2, 'text', 'ahead in material', 'behind in material').map((c) => c.problem)).toEqual([expect.stringMatching(/^white is \d+ up$/)]);
    expect(broken('candidate-moves', 3, 'text', 'Black has an extra knight', 'Black has an extra bishop').map((c) => c.problem)).toEqual([
      expect.stringMatching(/^black has -?\d+ more bishops, not 1$/),
    ]);
    expect(problems(lessonAt('4k3/pp6/8/8/8/8/P7/4K3 w - - 0 1', 'The pawns are level.', 'e1d1'))).toEqual(['White has 1 pawns and Black 2']);
    expect(problems(lessonAt(INITIAL_FEN, 'Material, the pieces and pawns each side has, is level.'))).toEqual([undefined]);
  });

  it("reads the review's hand-checked claims, all true", () => {
    // Claims the review checked by hand when the checker did not read them yet: now it does.
    const read = (id: string, at: string) => noteClaims(byId(id)).claims.filter((c) => c.at === `${id} ${at}`);
    for (const [id, at, phrase] of [
      ['candidate-moves', 'part 3 text', 'Black has an extra knight'],
      ['candidate-moves', 'part 3 text', 'you have one extra pawn'],
      ['when-to-trade', 'part 2 text', 'ahead in material'],
      ['rook-endgame-basics', 'part 1 text', 'the pawns are level'],
      ['minor-piece-endgames', 'part 1 text', 'The pawns are level'],
      ['weak-pawns', 'part 3 text', 'your pawns on b4 and d4 guard c5'],
      ['simple-plans', 'part 2 Bf6', "Only White's bishop on e3 defends the pawn"],
      ['queens-gambit', 'part 1 Nf3', 'Material, the pieces and pawns each side has, is level'],
      ['opening-principles', 'part 4 Be2', "c7 is guarded by Black's queen"],
    ] as const) {
      expect(read(id, at).find((c) => c.phrase === phrase), `${id} ${at}: ${phrase}`).toEqual({ kind: expect.any(String), at: `${id} ${at}`, phrase });
    }
  });
});
