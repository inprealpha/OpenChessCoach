// Golden tests of the explainability layer on real Lichess positions: each fact the Coach is given
// must be true on the board and confirmed by the line, because the Coach repeats it (ADR 0002).
// The lines are the Lichess puzzles' own solutions, so no Engine runs here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { playSan, playUci } from '../src/chess.ts';
import { describeFact, describeOutcome, lineOutcome, loosePieces, moveFacts, readLine, worthSaying, type MoveFact } from '../src/coach/explain.ts';
import { golden } from './golden.ts';

interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  themes: string[];
}

const puzzles: Puzzle[] = ['theme-puzzles.json', 'puzzles.json'].flatMap(
  (f) => (JSON.parse(readFileSync(new URL(`../../../data/${f}`, import.meta.url), 'utf8')) as { puzzles: Puzzle[] }).puzzles,
);

function puzzle(id: string): Puzzle {
  const p = puzzles.find((x) => x.id === id);
  if (!p) throw new Error(`No puzzle ${id}`);
  return p;
}

/** The position after the puzzle's first move (the real game's blunder), where the solution starts. */
function afterBlunder(p: Puzzle): string {
  return (playUci(p.fen, p.moves[0] as string) as { fenAfter: string }).fenAfter;
}

/** UCI moves for SAN moves played one after another from `fen`. */
function ucis(fen: string, sans: string[]): string[] {
  const out: string[] = [];
  let current = fen;
  for (const san of sans) {
    const played = playSan(current, san);
    if (!played) throw new Error(`${san} is illegal in ${current}`);
    out.push(played.uci);
    current = played.fenAfter;
  }
  return out;
}

const kinds = (facts: MoveFact[]) => facts.map((f) => f.kind);

describe('reading an Engine line', () => {
  it('names what each move takes, en passant and promotions included', () => {
    const fen = 'k7/4P3/8/3pP3/8/8/8/K7 w - d6 0 1';
    const [ep, promo] = readLine(fen, ['e5d6', 'a8b8', 'e7e8q']).filter((p) => p.side === 'white');
    expect(ep).toMatchObject({ san: 'exd6', captured: 'pawn' });
    expect(promo).toMatchObject({ san: 'e8=Q+', promotion: 'queen' });
  });

  it('stops at the first illegal move', () => {
    expect(readLine('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['e2e4', 'e2e4'])).toHaveLength(1);
  });
});

describe('what a line leads to', () => {
  it('counts the move and the forcing sequence after it, up to the first quiet move', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Bxf7+ Kd8 6. Ng4 Nh6 7. Nxh6: the quiet Qg5 ends
    // the count, so what the Engine's line guesses five moves on is not counted.
    const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const line = ucis(fen, ['Nxe5', 'Qg5', 'Bxf7+', 'Kd8', 'Ng4', 'Nh6', 'Nxh6']);
    expect(describeOutcome(lineOutcome('white', readLine(fen, line)))).toBe('White wins a pawn');
  });

  it('leaves out an exchange the line stops in the middle of', () => {
    // 1. e4 e5 2. Nf3 d6 3. Nxe5: the pawn on d6 takes back, though the line stops before it does.
    const fen = 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
    expect(describeOutcome(lineOutcome('white', readLine(fen, ucis(fen, ['Nxe5']))))).toBe('material stays level');
    expect(describeOutcome(lineOutcome('white', readLine(fen, ucis(fen, ['Nxe5', 'dxe5', 'Nc3']))))).toBe('White gives up a knight for a pawn (Nxe5 dxe5)');
  });

  it('cancels equal trades and words an uneven one from the side asked about', () => {
    // Puzzle aSgS1: after Qa6, Rxc1+ Ke2 Rxh1 Qxa7: Black takes a bishop and a rook for a pawn.
    const p = puzzle('aSgS1');
    const line = ucis(p.fen, ['Qa6', 'Rxc1+', 'Ke2', 'Rxh1', 'Qxa7']);
    expect(describeOutcome(lineOutcome('white', readLine(p.fen, line)))).toBe('White gives up a rook and a bishop for a pawn (Qa6 Rxc1+ Ke2 Rxh1 Qxa7)');
    expect(describeOutcome(lineOutcome('black', readLine(p.fen, line)))).toBe('Black wins a rook and a bishop for a pawn (Qa6 Rxc1+ Ke2 Rxh1 Qxa7)');
  });

  it('names a back-rank mate by the king’s own pawns, and a mate the score shows beyond the line', () => {
    // Puzzle K1mbr: Rxb8 allows Qc8+ Rxc8 Rxc8#.
    const p = puzzle('K1mbr');
    const outcome = lineOutcome('black', readLine(p.fen, p.moves));
    expect(outcome.line).toEqual(['Rxb8', 'Qc8+', 'Rxc8', 'Rxc8#']);
    expect(outcome.mate).toEqual({
      by: 'white',
      in: 2,
      // Black's only reply was to take the queen, so the mating position is the only one.
      boxedBy: [
        { side: 'black', role: 'pawn', square: 'f7' },
        { side: 'black', role: 'pawn', square: 'g7' },
        { side: 'black', role: 'pawn', square: 'h7' },
      ],
      giver: { side: 'white', role: 'rook', square: 'c8' },
      // The rook mates from a distance: nothing next to the king needs protecting.
      guardedBy: [],
    });
    expect(describeOutcome(outcome)).toBe("White mates in 2 (Rxb8 Qc8+ Rxc8 Rxc8#); at the end, Black's own pawns on f7, g7 and h7 block its king in");
    // Puzzle Hzxlt: after Bxf7+ the king has two moves, so where it ends up is not said.
    const choice = puzzle('Hzxlt');
    const mated = lineOutcome('white', readLine(afterBlunder(choice), choice.moves.slice(1)));
    expect(mated.mate).toEqual({ by: 'white', in: 2 });
    expect(describeOutcome(mated)).toBe(`White mates in 2 (${mated.line.join(' ')})`);
    expect(describeOutcome(lineOutcome('white', [], { mate: 3 }))).toBe('White mates in 3');
    expect(describeOutcome(lineOutcome('white', [], { mate: -2 }))).toBe('Black mates in 2');
    // A mate in one is one event: the move itself, or the very next move.
    expect(describeOutcome(lineOutcome('white', [], { mate: -1 }))).toBe("Black's next move is checkmate");
    expect(describeOutcome(lineOutcome('black', [], { mate: 1 }))).toBe('it is checkmate');
  });
});

describe('pieces that can be taken', () => {
  it('counts a piece attacked by a cheaper one, or not defended, and only legal captures', () => {
    // Puzzle twkjj after Qf4+ Kb1: Black's queen on f4 hangs to the knight on e2, and White's bishop on c4 to the queen.
    const p = puzzle('twkjj');
    const loose = loosePieces(afterBlunder(p)).map((l) => `${l.piece.role}@${l.piece.square}<${l.attacker.role}@${l.attacker.square}`);
    expect(loose).toContain('queen@f4<knight@e2');
  });

  it('ignores a capture a pin makes illegal', () => {
    // Puzzle 5faJv after Qxe5 Nf3+: the pawn on g2 attacks f3 but is pinned to the king by the rook on g8.
    const p = puzzle('5faJv');
    const fen = (playUci(p.fen, p.moves[0] as string) as { fenAfter: string }).fenAfter;
    const afterCheck = (playUci(fen, p.moves[1] as string) as { fenAfter: string }).fenAfter;
    expect(loosePieces(afterCheck).some((l) => l.piece.square === 'f3' && l.attacker.square === 'g2')).toBe(false);
  });
});

describe('what a move does', () => {
  it('a blunder that leaves a piece to be taken, when the line takes it', () => {
    // Puzzle aSgS1: Qa6 steps off the c-file and leaves the bishop on c1 to the rook on c8.
    const p = puzzle('aSgS1');
    const facts = moveFacts(p.fen, p.moves[0] as string, p.moves.slice(1));
    expect(facts).toContainEqual({
      kind: 'leaves',
      loose: { piece: { side: 'white', role: 'bishop', square: 'c1' }, attacker: { side: 'black', role: 'rook', square: 'c8' }, defended: false },
      moved: false,
      wasLoose: false,
    });
  });

  it('a knight check that also attacks the queen is a double attack on the king and the queen', () => {
    // Puzzle 3VaHO: after Qxc6, Ne7+ forks the king on g8 and the queen on c6.
    const p = puzzle('3VaHO');
    const fen = afterBlunder(p);
    const facts = moveFacts(fen, p.moves[1] as string, p.moves.slice(2));
    expect(facts).toContainEqual({
      kind: 'double-attack',
      by: { side: 'white', role: 'knight', square: 'e7' },
      targets: [{ side: 'black', role: 'king', square: 'g8' }, { side: 'black', role: 'queen', square: 'c6' }],
    });
  });

  it('a check the pinned pawn can’t take back', () => {
    // Puzzle 5faJv: after Qxe5, Nf3+ can't be taken by the pawn on g2, pinned by the rook on g8.
    const p = puzzle('5faJv');
    const facts = moveFacts(afterBlunder(p), p.moves[1] as string, p.moves.slice(2));
    expect(facts).toContainEqual({ kind: 'pinned-attackers', pins: [{ piece: { side: 'white', role: 'pawn', square: 'g2' }, by: { side: 'black', role: 'rook', square: 'g8' } }] });
    expect(facts.map(describeFact)).toContain("can't be taken by White's pawn on g2, which Black's rook on g8 pins to its own king");
  });

  it('a check along a line with a piece behind the king is a skewer, and the king move that allowed it stops guarding the square', () => {
    // Puzzle rRQ5u: Kg6 lets Rg8+ skewer the king on g6 and the rook on g3.
    const p = puzzle('rRQ5u');
    expect(moveFacts(p.fen, p.moves[0] as string, p.moves.slice(1))).toContainEqual({
      kind: 'stops-guarding',
      square: 'g8',
      next: { side: 'white', role: 'rook', square: 'g8' },
    });
    expect(moveFacts(afterBlunder(p), p.moves[1] as string, p.moves.slice(2))).toContainEqual({
      kind: 'skewer',
      king: { side: 'black', role: 'king', square: 'g6' },
      behind: { side: 'black', role: 'rook', square: 'g3' },
    });
  });

  it('a king walk that boxes in its own bishop, and only a king walk', () => {
    // 1. e4 e5 2. Ke2: the bishop on f1 has nowhere to go; 2. Be2 boxes in the queen for a while, which is normal.
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const ke2 = moveFacts(fen, 'e1e2', []);
    expect(ke2).toContainEqual({ kind: 'blocks', pieces: [{ side: 'white', role: 'bishop', square: 'f1' }] });
    expect(kinds(ke2)).toContain('gives-up-castling');
    expect(kinds(moveFacts(fen, 'f1e2', []))).not.toContain('blocks');
  });

  it('a forced reply is the only legal move', () => {
    // Puzzle qLLWy: after Nc6+, Ka8 is Black's only move.
    const p = puzzle('qLLWy');
    const fen = (playUci(afterBlunder(p), p.moves[1] as string) as { fenAfter: string }).fenAfter;
    expect(kinds(moveFacts(fen, p.moves[2] as string, p.moves.slice(3)))).toContain('only-move');
  });

  it('says nothing tactical about quiet, sound moves in real games', () => {
    // Every Best or Good move in the golden games that takes nothing, gives no check and leaves
    // nothing to be taken, with the Engine's line after it: no attack, double attack, skewer or
    // loose piece is claimed.
    const tactical = new Set(['attacks', 'double-attack', 'skewer', 'leaves', 'pinned-attackers', 'stops-guarding']);
    let checked = 0;
    const claimed: string[] = [];
    for (const g of golden.games) {
      g.moves.forEach((m, i) => {
        const next = g.moves[i + 1];
        if (!next || /[x+#]/.test(m.san) || !['Best', 'Good'].includes(m.grade)) return;
        if (loosePieces(m.fenBefore).length || loosePieces(m.fenAfter).length) return;
        const line = next.candidates[0]?.pv ?? [];
        // A quiet position stays quiet only while the line does: no capture in its first two moves.
        if (readLine(m.fenAfter, line.slice(0, 2)).some((p) => p.captured)) return;
        checked++;
        const facts = moveFacts(m.fenBefore, m.uci, line).filter((f) => tactical.has(f.kind));
        if (facts.length) claimed.push(`${g.site} ${m.ply}. ${m.san}: ${facts.map(describeFact).join('; ')}`);
      });
    }
    expect(checked).toBeGreaterThan(80);
    expect(claimed, claimed.slice(0, 5).join('\n')).toEqual([]);
  });

  it('every fact names pieces that stand where it says, on real game positions', () => {
    // An invariant over every graded move: a fact never names an empty or wrong square.
    let facts = 0;
    for (const g of golden.games) {
      g.moves.forEach((m, i) => {
        const line = g.moves[i + 1]?.candidates[0]?.pv ?? [];
        for (const f of moveFacts(m.fenBefore, m.uci, line)) {
          facts++;
          const board = boardOf(m.fenAfter);
          const check = (p: { side: string; role: string; square: string }) => expect(board.get(p.square), `${g.site} ${m.ply}. ${m.san}: ${describeFact(f)}`).toBe(`${p.side} ${p.role}`);
          if (f.kind === 'leaves') [f.loose.piece, f.loose.attacker].forEach(check);
          if (f.kind === 'attacks') f.targets.flatMap((t) => [t.piece, t.attacker]).forEach(check);
          if (f.kind === 'double-attack') [f.by, ...f.targets].forEach(check);
          if (f.kind === 'skewer') [f.king, f.behind].forEach(check);
          if (f.kind === 'pinned-attackers') f.pins.flatMap((p) => [p.piece, p.by]).forEach(check);
          if (f.kind === 'blocks') f.pieces.forEach(check);
        }
      });
    }
    expect(facts).toBeGreaterThan(200);
  });
});

describe('facts the adversarial reviews broke, on real positions', () => {
  // Each row: a position, a move and the line after it, the facts that must be there and the ones that must not.
  it.each([
    // Puzzle uY6qd: the rook on g1 moves away; the later capture on g1 takes the other rook.
    ['r4r1k/2p3pp/p7/P3P2n/1B2Q3/7q/1P3b1P/RN4RK w - - 0 28', ['Bxf8', 'Ng3+', 'Rxg3', 'Qf1+', 'Rg1', 'Qxg1#'], [], ['leaves']],
    // Puzzle M5aMk: the queen takes the bishop, so the pinned pawn that can't is beside the point.
    ['r1b1q1nr/ppp2Np1/1b1p1k1p/nP6/4P3/2P2Q2/P2P1PPP/RNB1K2R b KQ - 3 11', ['Bf5', 'Qxf5+', 'Ke7', 'Nxh8'], ['leaves'], ['pinned-attackers']],
    // A defender pinned to its king can't take back: Nd5 lands where only the pinned e4 pawn guards it.
    ['3qr1k1/8/8/p7/1N2P3/8/8/4K3 w - - 0 1', ['Nd5', 'Qxd5'], ['leaves'], []],
    // Nf6+ is taken at once; the queen falls to the queen behind the bishop, not to the knight.
    ['r4rk1/1b1q1ppp/p3p3/2p5/4NP2/3BnP2/PP4PP/R2Q1RK1 w - - 2 16', ['Nf6+', 'gxf6', 'Bxh7+', 'Kxh7', 'Qxd7'], [], ['double-attack']],
    // The king takes the checking rook, so nothing behind it is skewered.
    ['2R5/1p6/5rqp/p2kp1p1/Pp1n4/3P2Q1/5RPP/7K w - - 0 40', ['Rc5+', 'Kxc5', 'Qxe5+', 'Kc6'], [], ['skewer']],
    // A real skewer: Rg3+ and the rook takes on g7.
    ['7r/3Bn1pp/Q7/P3ppk1/4q3/2PR4/1P4PP/5R1K w - - 5 25', ['Rg3+', 'Kh4', 'Rxg7'], ['skewer'], []],
    // The queen still guards e2: Bxe2 Qxe2 is a trade, not a square the castling gave up.
    ['r3k1nr/ppp2ppp/2n5/3qp3/8/2BP1b2/PPP1BPPP/R2QK2R w KQkq - 0 9', ['O-O', 'Bxe2', 'Qxe2'], [], ['stops-guarding']],
    // Qxe4 leaves f2 to the queen's mate.
    ['r1b2rk1/ppp3pp/2p5/4p3/3Pn2q/2P2Q2/PP1N2PP/R1B3KR w - - 0 12', ['Qxe4', 'Qf2#'], ['stops-guarding'], []],
  ] as const)('%s %s', (fen, sans, present, absent) => {
    const [uci, ...line] = ucis(fen, [...sans]);
    const got = kinds(moveFacts(fen, uci as string, line));
    for (const k of present) expect(got, `${sans[0]} should say ${k}`).toContain(k);
    for (const k of absent) expect(got, `${sans[0]} should not say ${k}`).not.toContain(k);
  });

  it('counts a promotion as material, so a new queen taken straight back is no gain', () => {
    // g8=Q Bxg8 Rxg8: the pawn became a queen and was taken, then the rook took the bishop.
    const fen = '5R2/6P1/8/7n/k2K4/8/b7/8 w - - 9 55';
    expect(describeOutcome(lineOutcome('white', readLine(fen, ucis(fen, ['g8=Q', 'Bxg8', 'Rxg8']))))).toBe('White wins a bishop for a pawn (g8=Q Bxg8 Rxg8)');
    // A quiet first move ends the count: a promotion further on is not counted at all.
    const before = '1R6/6P1/5n2/8/k2K4/8/b7/8 w - - 7 54';
    expect(describeOutcome(lineOutcome('white', readLine(before, ucis(before, ['Rf8', 'Nh5', 'g8=Q', 'Bxg8', 'Rxg8']))))).toBe('material stays level');
  });

  it('leaves a win unsaid when the piece that won it is lost a few moves later', () => {
    // Nc2+ Kd2 Nxa1 wins the rook, but the Engine's line traps the knight: Nxb3+ Bxb3 seven moves on.
    const fen = 'r4k1r/3n1ppp/p2Np3/8/1n1P4/4P3/1P3PPP/R3KB1R b KQ - 1 19';
    const line = ucis(fen, ['Nc2+', 'Kd2', 'Nxa1', 'Bc4', 'Ke7', 'Ne4', 'Rhc8', 'b3', 'Nxb3+', 'Bxb3', 'Rab8', 'Rb1']);
    const outcome = lineOutcome('black', readLine(fen, line));
    expect(describeOutcome(outcome)).toBe('Black wins a rook (Nc2+ Kd2 Nxa1)');
    expect(outcome.settled).toBe(false);
    expect(worthSaying(outcome, fen, { cp: 380 })).toBe(false);
    // The fork itself is still said: the knight checks the king and attacks the rook.
    expect(kinds(moveFacts(fen, line[0] as string, line.slice(1)))).toContain('double-attack');
  });

  it('keeps a count that later, even trades in the line leave as it was', () => {
    // Puzzle twkjj: Kb1 Qxc4 loses the bishop; the line's trades on c3 and e1 further on cancel out.
    const fen = 'rn2r1k1/ppp2ppp/8/3P4/1bB2qb1/2N5/PPQ1N1PP/2K1R2R w - - 2 14';
    const line = ucis(fen, ['Kb1', 'Qxc4', 'b3', 'Qc5', 'a3', 'Na6', 'Ng3', 'Qxc3', 'Qxc3', 'Rxe1+', 'Rxe1', 'Bxc3']);
    const outcome = lineOutcome('white', readLine(fen, line));
    expect(describeOutcome(outcome)).toBe('White loses a bishop (Kb1 Qxc4)');
    expect(outcome.settled).toBe(true);
  });

  it('says a loss the Engine’s score agrees with, though the score grows slower than the material', () => {
    // Bf2 lets Bxh2+ Kxh2 Qxe6: White loses the queen, and the Engine scores it -5.37.
    const fen = '2r4r/ppk3pp/1q1bQp2/8/3pP3/4B3/PPP3PP/R4RK1 w - - 0 19';
    const outcome = lineOutcome('white', readLine(fen, ucis(fen, ['Bf2', 'Bxh2+', 'Kxh2', 'Qxe6', 'Bxd4', 'Qd6+', 'e5', 'Qxd4'])));
    expect(describeOutcome(outcome)).toBe('White loses a queen (Bf2 Bxh2+ Kxh2 Qxe6 Bxd4 Qd6+ e5 Qxd4)');
    expect(worthSaying(outcome, fen, { cp: -537 })).toBe(true);
    // The same count with a score that says the opposite is left unsaid.
    expect(worthSaying(outcome, fen, { cp: 300 })).toBe(false);
  });

  it('names a mated king’s own pieces only when they take its squares away', () => {
    // Qxg2#: the queen on g2 covers f2 and h2 itself, so the pawns there block nothing.
    const fen = 'r2r1k2/pb3ppQ/1p2pb2/3q4/3N4/4B3/PPB2PPP/R3R1K1 b - - 0 17';
    const outcome = lineOutcome('black', readLine(fen, ucis(fen, ['Qxg2#'])));
    expect(outcome.mate?.boxedBy).toEqual([]);
    expect(describeOutcome(outcome)).not.toContain('block');
  });
});

/** "e4" → "white pawn" for every occupied square of `fen`. */
function boardOf(fen: string): Map<string, string> {
  const names: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const out = new Map<string, string>();
  fen.split(' ')[0]?.split('/').forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        out.set(`${'abcdefgh'[file]}${8 - r}`, `${ch === ch.toUpperCase() ? 'white' : 'black'} ${names[ch.toLowerCase()]}`);
        file++;
      }
    }
  });
  return out;
}
