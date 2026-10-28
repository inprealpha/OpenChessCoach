// The Coach brief budget (ADR 0004) and the Coach-move guard (ADR 0002), each proven to fail on
// a deliberately broken input.
import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/analysis.ts';
import type { Analysis } from '../src/engine.ts';
import { assertBriefWithinBudget, BRIEF_BUDGET, BriefTooLargeError, briefSize, buildBrief, profileSlice, type Brief } from '../src/coach/brief.ts';
import { allowedMoves, askedLineMoves, guardReply } from '../src/coach/guard.ts';
import type { CoachAsk, CoachRawReply } from '../src/coach/types.ts';
import { legalMoves, playUci, turnOf } from '../src/chess.ts';
import { MAX_GOAL, MAX_KEY_IDEA } from '../src/content/lessons.ts';
import { scoreAfterPly } from '../src/position-score.ts';
import { nullMoveFen, type Threat } from '../src/threat.ts';
import { winningChancesFor } from '../src/winning-chances.ts';
// The bar's own function on the Board and in Engine Games, so the brief is compared with the screen.
import { scoreFromAnalysis } from '../../web/src/lib/position-score.ts';
import { game, golden } from './golden.ts';

const profile = {
  level: 'casual' as const,
  rating: 1450,
  goals: ['Learn the Italian Game properly', 'Blunder less in the endgame'],
  weaknesses: ['Italian Game: 4 Mistakes in 30 moves'],
  notes: [{ id: 1, text: 'Often trades the Italian bishop too early', createdAt: '2026-01-01' }, { id: 2, text: 'Plays the Caro-Kann as Black', createdAt: '2026-01-01' }],
};

/** A Review moment late in a long real game, the largest brief the app builds. */
function longGameAsk(at = 60, id = 'fzjtms6a'): CoachAsk {
  const g = game(id);
  const m = g.moves[at];
  if (!m) throw new Error('fixture too short');
  return {
    job: 'review-moment',
    fen: m.fenBefore,
    recentMoves: g.moves.slice(0, at).map((x) => x.san),
    playerSide: 'white',
    move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
    candidates: m.candidates,
    replies: g.moves[at + 1]?.candidates ?? [],
    question: 'x'.repeat(2000),
    opening: 'Italian Game',
    allowNote: true,
  };
}

/** A legal line of `plies` moves from `fen`, each the first legal move: only its length matters. */
function someLine(fen: string, plies: number): string[] {
  const line: string[] = [];
  let current = fen;
  for (let i = 0; i < plies; i++) {
    const uci = legalMoves(current)[0];
    const played = uci ? playUci(current, uci) : undefined;
    if (!uci || !played) break;
    line.push(uci);
    current = played.fenAfter;
  }
  return line;
}

/** A threat for the opponent in `fen`: a legal move of theirs after a pass, with a full line. */
function someThreat(fen: string): Threat {
  const swapped = nullMoveFen(fen) as string;
  const pv = someLine(swapped, 8);
  const first = playUci(swapped, pv[0] as string);
  if (!first) throw new Error('no legal move for the opponent');
  return { side: turnOf(swapped), uci: first.uci, san: first.san, pv, score: { cp: 250 }, winLoss: 0.2 };
}

describe('the Coach brief', () => {
  it('stays within its budget for a long game, with a huge question and summary', () => {
    const brief = buildBrief({ ask: longGameAsk(), profile, summary: 'y'.repeat(5000) });
    expect(briefSize(brief)).toBeLessThanOrEqual(BRIEF_BUDGET);
    expect(() => assertBriefWithinBudget(brief)).not.toThrow();
  });

  it('stays within its budget with the opponent’s threat added, in the position and after a move', () => {
    // 25... Re2, where the Engine's best reply is the capture Rxe2: the move leaves that threat on.
    const ask = longGameAsk(50);
    const best = ask.replies?.[0] as Candidate;
    const afterMove = buildBrief({ ask: { ...ask, threat: { ...someThreat(ask.fen), uci: best.uci, pv: best.pv } }, profile, summary: 'y'.repeat(5000) });
    expect(afterMove.threat).toMatchObject({ uci: best.uci, ignored: true });
    expect(briefSize(afterMove)).toBeLessThanOrEqual(BRIEF_BUDGET);
    // The same moment asked about as a position: the threat after a pass, with a full line.
    const inPosition = buildBrief({ ask: { ...ask, move: undefined, replies: undefined, threat: someThreat(ask.fen) }, profile, summary: 'y'.repeat(5000) });
    expect(inPosition.threat).toBeDefined();
    expect(briefSize(inPosition)).toBeLessThanOrEqual(BRIEF_BUDGET);
  });

  it('stays within its budget with two moves the Player asked about, keeping their facts and lines whole', () => {
    // 25. Qxe6+ and 25. Qxb7, which the Engine doesn't list.
    const ask = longGameAsk(48);
    const best = ask.replies?.[0] as Candidate;
    // Two captures the Engine didn't list, each with a full line, as the desktop grades them.
    const asked = legalMoves(ask.fen)
      .filter((uci) => uci !== ask.move?.uci && !ask.candidates.some((c) => c.uci === uci))
      .map((uci) => playUci(ask.fen, uci) as NonNullable<ReturnType<typeof playUci>>)
      .filter((played) => played.san.includes('x'))
      .slice(0, 2)
      .map((played) => ({ uci: played.uci, san: played.san, score: { cp: -300 }, pv: [played.uci, ...someLine(played.fenAfter, 8)] }));
    expect(asked).toHaveLength(2);
    const question = `Why not ${asked.map((a) => a.san).join(' or ')}? ${'x'.repeat(300)}`;
    const why = { ...ask, job: 'why' as const, question, asked, threat: { ...someThreat(ask.fen), uci: best.uci, pv: best.pv } };
    const brief = buildBrief({ ask: why, profile, summary: 'y'.repeat(5000) });
    expect(briefSize(brief)).toBeLessThanOrEqual(BRIEF_BUDGET);
    const shown = brief.candidates.filter((c) => c.asked);
    expect(shown.map((c) => c.uci)).toEqual(asked.map((a) => a.uci));
    for (const c of shown) {
      expect(c.does).toMatch(/^takes /);
      expect(c.line.split(' ')).toHaveLength(4);
    }
    // Without them the brief is the same, so asking costs the other moves nothing.
    const without = buildBrief({ ask: { ...why, asked: undefined }, profile, summary: 'y'.repeat(5000) });
    expect(brief.candidates.slice(0, without.candidates.length)).toEqual(without.candidates);
  });

  it('carries a Lesson’s focus in a Lesson turn, a Hint and a Why Question, and none outside a Lesson', () => {
    const g = game('i425hmuv');
    const m = g.moves[2] as (typeof g.moves)[number]; // 2. Bc4
    const lessonFocus = {
      name: 'Italian Game',
      goal: 'Play the first moves of the Italian Game and say what each one is for.',
      keyIdea: 'Aim the bishop at f7, the square only the king defends.',
    };
    const ask: CoachAsk = {
      job: 'lesson-turn',
      fen: m.fenBefore,
      recentMoves: ['e4', 'e5'],
      playerSide: 'white',
      move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
      candidates: m.candidates,
      replies: g.moves[3]?.candidates ?? [],
      lessonFocus,
    };
    // A Hint is asked before the move, in the position.
    for (const job of ['lesson-turn', 'hint', 'why'] as const) {
      const brief = buildBrief({ ask: { ...ask, job, ...(job === 'hint' ? { move: undefined, replies: undefined } : {}) }, profile });
      expect(brief.focus, job).toEqual({ lesson: 'Italian Game', goal: lessonFocus.goal, keyIdea: lessonFocus.keyIdea });
    }
    expect(buildBrief({ ask: { ...ask, lessonFocus: undefined }, profile })).not.toHaveProperty('focus');
    // A Lesson with no goal or key idea has no point to keep the Coach on.
    expect(buildBrief({ ask: { ...ask, lessonFocus: { name: 'Italian Game', goal: ' ', keyIdea: '' } }, profile })).not.toHaveProperty('focus');
  });

  it('keeps a Lesson’s focus whole in the largest brief of every Lesson job, within its budget', () => {
    // Longer than the Lesson check allows: the brief clips them to its limits.
    const lessonFocus = { name: 'n'.repeat(200), goal: 'g'.repeat(MAX_GOAL + 100), keyIdea: 'k'.repeat(MAX_KEY_IDEA + 100) };
    const focus = { lesson: `${'n'.repeat(79)}…`, goal: `${'g'.repeat(MAX_GOAL - 1)}…`, keyIdea: `${'k'.repeat(MAX_KEY_IDEA - 1)}…` };
    // Every profile item matches the Lesson, each longer than the brief keeps.
    const matching = (kind: string) => [1, 2, 3].map((i) => `Italian Game ${kind} ${i} ${'x'.repeat(150)}`);
    const fullProfile = { ...profile, goals: matching('goal'), weaknesses: matching('weakness'), notes: matching('note').map((text, id) => ({ id, text, createdAt: '2026-01-01' })) };
    const lesson = { lessonId: 'italian-game', opening: 'Italian Game', notes: 'z'.repeat(2000), popularity: ['Nf3', 'Bc4', 'd4', 'Nc3', 'Bb5'].map((san) => ({ san, percent: 12.5 })), finalTurn: true };
    // The long game’s late moment, and 15... Bxe4 in game xd9vkd47, where the fully trimmed brief is
    // largest over every golden move.
    for (const base of [longGameAsk(), longGameAsk(29, 'xd9vkd47')]) {
      const best = base.replies?.[0] as Candidate;
      // Two moves the Engine didn't list, each with a full line, for the Why Question to name.
      const asked = legalMoves(base.fen)
        .filter((uci) => uci !== base.move?.uci && !base.candidates.some((c) => c.uci === uci))
        .slice(0, 2)
        .map((uci) => ({ uci, san: '', score: { cp: -300 }, pv: [uci, ...someLine((playUci(base.fen, uci) as { fenAfter: string }).fenAfter, 8)] }));
      const afterMove: CoachAsk = { ...base, lessonFocus, threat: { ...someThreat(base.fen), uci: best.uci, pv: best.pv } };
      const inPosition: CoachAsk = { ...afterMove, move: undefined, replies: undefined, threat: someThreat(base.fen) };
      for (const ask of [afterMove, inPosition]) {
        for (const job of ['lesson-turn', 'hint', 'why'] as const) {
          const extra = job === 'lesson-turn' ? { lesson } : job === 'why' ? { asked } : {};
          const brief = buildBrief({ ask: { ...ask, job, ...extra }, profile: fullProfile, summary: 'y'.repeat(5000) });
          const where = `${job} ${base.fen}${ask.move ? '' : ' (position)'}`;
          expect(briefSize(brief), where).toBeLessThanOrEqual(BRIEF_BUDGET);
          expect(brief.focus, where).toEqual(focus);
        }
      }
    }
  });

  it('carries the opponent’s threat as the Engine found it: who threatens, the move and its line', () => {
    // 1. e4 d5: Black threatens dxe4.
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const threat: Threat = { side: 'black', uci: 'd5e4', san: 'dxe4', pv: ['d5e4', 'b1c3', 'g8f6'], score: { cp: 120 }, winLoss: 0.15 };
    const ask: CoachAsk = { job: 'why', fen, recentMoves: ['e4', 'd5'], candidates: [{ uci: 'e4d5', san: 'exd5', score: { cp: 40 }, pv: ['e4d5', 'd8d5'] }], threat };
    expect(buildBrief({ ask, profile }).threat).toEqual({ by: 'black', san: 'dxe4', uci: 'd5e4', line: 'Nc3 Nf6' });
    // No threat, no field.
    expect(buildBrief({ ask: { ...ask, threat: undefined }, profile })).not.toHaveProperty('threat');
    // A threat that isn't a legal move for the opponent never reaches the Coach.
    expect(buildBrief({ ask: { ...ask, threat: { ...threat, uci: 'd5d3' } }, profile })).not.toHaveProperty('threat');
  });

  it('keeps the threat after a move only when the Engine’s best reply to the move is that threat, and says so', () => {
    // 1. e4 d5: Black threatens dxe4, as the Engine found it after a pass.
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const threat: Threat = { side: 'black', uci: 'd5e4', san: 'dxe4', pv: ['d5e4', 'd2d4', 'g8f6'], score: { cp: 128 }, winLoss: 0.34 };
    const after = (uci: string, replies: Candidate[]): CoachAsk => ({
      job: 'why',
      fen,
      recentMoves: ['e4', 'd5'],
      playerSide: 'white',
      move: { uci, san: '', grade: 'Good', playedScore: { cp: 0 } },
      candidates: [{ uci: 'e4d5', san: 'exd5', score: { cp: 60 }, pv: ['e4d5', 'd8d5'] }],
      replies,
      threat,
    });
    const reply = (uci: string, pv: string[] = [uci]): Candidate => ({ uci, san: '', score: { cp: 0 }, pv });
    // 2. Nf3: the Engine's best reply is still dxe4, so the brief says the move left the threat on,
    // with the Engine's line after the move.
    expect(buildBrief({ ask: after('g1f3', [reply('d5e4', ['d5e4', 'f3g5', 'g8f6']), reply('e7e6')]), profile }).threat).toEqual({
      by: 'black',
      san: 'dxe4',
      uci: 'd5e4',
      line: 'Ng5 Nf6',
      ignored: true,
    });
    // 2. exd5 took the pawn: dxe4 isn't even legal any more.
    expect(buildBrief({ ask: after('e4d5', [reply('d8d5')]), profile })).not.toHaveProperty('threat');
    // 2. Nc3 defends e4, and the Engine's best reply is 2... d4, not the threat.
    expect(buildBrief({ ask: after('b1c3', [reply('d5d4'), reply('d5e4')]), profile })).not.toHaveProperty('threat');
    // With no replies from the Engine, there is nothing to say the threat still stands.
    expect(buildBrief({ ask: after('g1f3', []), profile })).not.toHaveProperty('threat');
    // 1. e4 Nf6 2. e5: the knight's best reply goes to e4, but there is nothing left to take there.
    const nf6 = 'rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2';
    const nxe4: Threat = { side: 'black', uci: 'f6e4', san: 'Nxe4', pv: ['f6e4'], score: { cp: 300 }, winLoss: 0.5 };
    expect(buildBrief({ ask: { ...after('e4e5', [reply('f6e4')]), fen: nf6, candidates: [], threat: nxe4 }, profile })).not.toHaveProperty('threat');
  });

  it('never carries a threat after a move that ends the game, checkmate or stalemate', () => {
    const ask = (fen: string, uci: string, threat: Threat): CoachAsk => ({
      job: 'lesson-turn',
      fen,
      recentMoves: [],
      playerSide: 'white',
      move: { uci, san: '', grade: 'Best', playedScore: { cp: 0 } },
      candidates: [],
      // The Engine has no replies once the game is over; even a forged one can't keep the threat.
      replies: [{ uci: threat.uci, san: '', score: { cp: 0 }, pv: [threat.uci] }],
      threat,
    });
    // The Back-rank mate Lesson: Black threatens Rxd1+, and Rxd8# takes the rook with mate.
    const backRank = '3r2k1/p4ppp/qp6/8/8/1P6/P1B2PPP/3R2K1 w - - 0 4';
    const rxd1: Threat = { side: 'black', uci: 'd8d1', san: 'Rxd1+', pv: ['d8d1'], score: { cp: 900 }, winLoss: 0.9 };
    expect(buildBrief({ ask: ask(backRank, 'd1d8', rxd1), profile })).not.toHaveProperty('threat');
    expect(buildBrief({ ask: { ...ask(backRank, 'd1d8', rxd1), replies: [] }, profile })).not.toHaveProperty('threat');
    // Black's pawn threatens hxg1=Q, and 1. Ne2 leaves Black no legal move: stalemate.
    const stalemate = '7k/5K2/6Q1/8/8/8/7p/6NB w - - 0 1';
    const promote: Threat = { side: 'black', uci: 'h2g1q', san: 'hxg1=Q', pv: ['h2g1q'], score: { cp: 0 }, winLoss: 0.2 };
    expect(buildBrief({ ask: ask(stalemate, 'g1e2', promote), profile })).not.toHaveProperty('threat');
  });

  it('the budget check fails on an oversized brief', () => {
    const brief = buildBrief({ ask: longGameAsk(), profile });
    const oversized: Brief = { ...brief, summary: 'z'.repeat(BRIEF_BUDGET) };
    expect(() => assertBriefWithinBudget(oversized)).toThrow(BriefTooLargeError);
  });

  it('carries only the Engine’s judgements: no field for the Coach’s own evaluation', () => {
    const brief = buildBrief({ ask: longGameAsk(), profile });
    expect(Object.keys(brief)).not.toContain('evaluation');
    expect(brief.candidates.length).toBeGreaterThan(0);
    for (const c of brief.candidates) expect(c.evaluation).toMatch(/^([+-]\d+\.\d\d|-?M\d+|0\.00)$/);
  });

  it('carries the Winning Chances the Board’s bar shows either side of every golden move', () => {
    // The bar reads the Engine's best line in the position on the board. The golden lines are what
    // the Engine reports at verify mode's depth, in the browser and on the desktop alike.
    const analysisOf = (fen: string, lines: readonly Candidate[]): Analysis => ({ fen, depth: 10, lines: lines.map((c) => ({ pv: c.pv, score: c.score, depth: 10 })) });
    const bar = (fen: string, lines: readonly Candidate[]) => {
      const shown = scoreFromAnalysis(fen, analysisOf(fen, lines));
      return shown ? winningChancesFor(shown.score, shown.pov, 'white').text : undefined;
    };
    const differ: string[] = [];
    let compared = 0;
    for (const g of golden.games) {
      g.moves.forEach((m, i) => {
        const replies = g.moves[i + 1]?.candidates ?? [];
        const shown = { before: bar(m.fenBefore, m.candidates), after: bar(m.fenAfter, replies) };
        // The last move of an unfinished game: the fixture has no Engine lines after it.
        if (!shown.after) return;
        const ask: CoachAsk = {
          job: 'why',
          fen: m.fenBefore,
          recentMoves: [],
          playerSide: 'white',
          move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
          candidates: m.candidates,
          replies,
        };
        const said = buildBrief({ ask, profile }).winningChances;
        compared++;
        if (said?.before !== shown.before || said?.after !== shown.after) differ.push(`${g.site} ${m.ply}. ${m.san}: the bar ${shown.before} → ${shown.after}, the brief ${said?.before} → ${said?.after}`);
      });
    }
    expect(compared).toBeGreaterThan(300);
    expect(differ.length, differ.slice(0, 3).join('\n')).toBe(0);
  });

  it('carries a Review moment’s Winning Chances from the scores its card and bar show', () => {
    // A Review scores each position with the graded move that led to it, which the desktop passes.
    const g = game('fzjtms6a');
    const ply = 61;
    const [before, after] = [scoreAfterPly(g.moves, ply - 1), scoreAfterPly(g.moves, ply)];
    if (!before || !after) throw new Error('fixture too short');
    const brief = buildBrief({ ask: { ...longGameAsk(), positionBefore: before, positionAfter: after }, profile });
    expect(brief.winningChances).toEqual({ before: winningChancesFor(before.score, before.pov, 'white').text, after: winningChancesFor(after.score, after.pov, 'white').text });
  });

  it('carries only the Winning Chances in the position when there is no move, for the side to move', () => {
    const { move: _move, playerSide: _side, ...rest } = longGameAsk();
    const brief = buildBrief({ ask: { ...rest, job: 'why' }, profile });
    const best = rest.candidates[0];
    if (!best) throw new Error('fixture has no candidates');
    expect(brief.winningChances).toEqual({ before: winningChancesFor(best.score, turnOf(rest.fen)).text });
  });

  it('includes only the slice of the Player Profile that matches the topic', () => {
    expect(profileSlice(profile, 'Italian Game')).toEqual({
      goals: ['Learn the Italian Game properly'],
      weaknesses: ['Italian Game: 4 Mistakes in 30 moves'],
      notes: ['Often trades the Italian bishop too early'],
    });
    expect(profileSlice(profile, 'London System')).toBeUndefined();
  });

  it('keeps the recent moves numbered from the current position', () => {
    const g = game('i425hmuv');
    const m = g.moves[6] as (typeof g.moves)[number];
    const brief = buildBrief({ ask: { job: 'why', fen: m.fenBefore, recentMoves: g.moves.slice(0, 6).map((x) => x.san), candidates: m.candidates }, profile });
    expect(brief.recentMoves).toBe('1. e4 e5 2. Bc4 Nc6 3. Nf3 Bc5');
  });

  it('names no moves in a Hint’s facts, and trims the facts last to keep a brief in budget', () => {
    // Puzzle Hzxlt: Bxf7+ mates in 2; a Hint may say so, but not with the moves.
    const fen = 'r2qkb1r/ppp2pp1/2np1n1p/4p3/2B1P3/1QP2b1P/PP1P1PP1/RNB1R1K1 w kq - 0 9';
    const pv = ['c4f7', 'e8e7', 'b3e6'];
    const ask: CoachAsk = { job: 'hint', fen, recentMoves: [], playerSide: 'white', candidates: [{ uci: 'c4f7', san: 'Bxf7+', score: { mate: 2 }, pv }] };
    const hint = buildBrief({ ask, profile });
    expect(hint.candidates[0]?.result).toBe('White mates in 2');
    expect(buildBrief({ ask: { ...ask, job: 'why' }, profile }).candidates[0]?.result).toContain('(Bxf7+');
    // A brief made too big by a long question and summary still fits once facts are trimmed.
    const big = buildBrief({ ask: { ...longGameAsk(), question: 'x'.repeat(2000) }, profile, summary: 'y'.repeat(5000) });
    expect(briefSize(big)).toBeLessThanOrEqual(BRIEF_BUDGET);
  });

  it('keeps Live Coaching and Hint briefs short: facts only on the move, the best move and the best reply', () => {
    const g = game('i425hmuv');
    const m = g.moves[20] as (typeof g.moves)[number]; // 11. Bxf7+
    const ask: CoachAsk = {
      job: 'live',
      fen: m.fenBefore,
      recentMoves: [],
      playerSide: 'white',
      move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
      candidates: m.candidates,
      replies: g.moves[21]?.candidates ?? [],
    };
    for (const job of ['live', 'hint'] as const) {
      const brief = buildBrief({ ask: { ...ask, job }, profile });
      expect(brief.candidates.slice(1).every((c) => !c.does && !c.result), job).toBe(true);
      expect(brief.replies?.slice(1).every((r) => !r.does), job).toBe(true);
    }
    expect(buildBrief({ ask, profile }).move?.does).toContain("takes Black's pawn on f7");
  });
});

describe('the Coach-move guard', () => {
  const g = game('i425hmuv');
  const m = g.moves[20] as (typeof g.moves)[number]; // 11. Bxf7+
  const ask: CoachAsk = {
    job: 'review-moment',
    fen: m.fenBefore,
    recentMoves: [],
    move: { uci: m.uci, san: m.san, grade: m.grade, playedScore: m.playedScore },
    candidates: m.candidates,
    replies: g.moves[21]?.candidates ?? [],
  };
  const brief = buildBrief({ ask, profile });
  const reply = (over: Partial<CoachRawReply>): CoachRawReply => ({ text: 'x', moves: [], arrows: [], highlights: [], note: null, ...over });

  it('allows the Engine’s candidates, the move itself and the replies to it', () => {
    const allowed = allowedMoves(brief);
    for (const c of brief.candidates) expect(allowed.has(c.uci)).toBe(true);
    expect(allowed.has(m.uci)).toBe(true);
    for (const r of brief.replies ?? []) expect(allowed.has(r.uci)).toBe(true);
  });

  it('strips a legal move the Engine never suggested, and an illegal one', () => {
    const notSuggested = 'h2h3';
    expect(allowedMoves(brief).has(notSuggested)).toBe(false);
    const best = brief.candidates[0]?.uci as string;
    const out = guardReply(brief, reply({ moves: [best, notSuggested, 'e1e8'], arrows: [{ uci: notSuggested, brush: 'red' }, { uci: best, brush: 'green' }] }));
    expect(out.moves).toEqual([best]);
    expect(out.arrows).toEqual([{ from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' }]);
    expect(out.stripped).toHaveLength(3);
  });

  it('allows the opponent’s threat, legal after a pass, and still strips a move that is neither a candidate nor the threat', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const threat: Threat = { side: 'black', uci: 'd5e4', san: 'dxe4', pv: ['d5e4'], score: { cp: 120 }, winLoss: 0.15 };
    const withThreat = buildBrief({
      ask: { job: 'why', fen, recentMoves: [], candidates: [{ uci: 'e4d5', san: 'exd5', score: { cp: 40 }, pv: ['e4d5'] }], threat },
      profile,
    });
    const out = guardReply(withThreat, reply({ moves: ['e4d5', 'd5e4', 'h2h3'], arrows: [{ uci: 'd5e4', brush: 'red' }] }));
    expect(out.moves).toEqual(['e4d5', 'd5e4']);
    expect(out.arrows).toEqual([{ from: 'd5', to: 'e4', brush: 'red' }]);
    expect(out.stripped).toEqual(['move h2h3 is not in the Engine\'s output']);
    // Without the threat in the brief, the same move is stripped.
    const without = buildBrief({ ask: { job: 'why', fen, recentMoves: [], candidates: [{ uci: 'e4d5', san: 'exd5', score: { cp: 40 }, pv: ['e4d5'] }] }, profile });
    expect(guardReply(without, reply({ moves: ['d5e4'] })).moves).toEqual([]);
  });

  it('allows the threat’s move only where it is legal: after the move, when the brief has one', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const threat = { by: 'black' as const, san: 'dxe4', uci: 'd5e4', line: '' };
    const base: Brief = { ...brief, fen, candidates: [], move: undefined, replies: undefined, threat };
    // 2. Nf3 left the threat on: dxe4 is legal after it.
    expect(allowedMoves({ ...base, move: { san: 'Nf3', uci: 'g1f3', grade: 'Mistake', evaluationAfter: '-1.10' }, threat: { ...threat, ignored: true } }).has('d5e4')).toBe(true);
    // 2. exd5 took the pawn: a brief that still carried the threat would not get it past the guard.
    const exd5: Brief = { ...base, move: { san: 'exd5', uci: 'e4d5', grade: 'Best', evaluationAfter: '+0.60' } };
    expect(allowedMoves(exd5).has('d5e4')).toBe(false);
    expect(guardReply(exd5, reply({ moves: ['d5e4'], arrows: [{ uci: 'd5e4', brush: 'red' }] }))).toMatchObject({ moves: [], arrows: [] });
  });

  it('lets the Coach name the Engine’s line after a move the Player asked about, each move where the line plays it, but draw only the move', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4, and the Player asks about 4. Nxe5: 4… Qg5 5. Bxf7+ Kd8 6. Ng4.
    const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const nxe5 = { uci: 'f3e5', san: 'Nxe5', score: { cp: -50 }, pv: ['f3e5', 'd8g5', 'c4f7', 'e8d8', 'e5g4'] };
    const why = (asked?: Candidate[]) =>
      buildBrief({ ask: { job: 'why', fen, recentMoves: [], candidates: [{ uci: 'e1g1', san: 'O-O', score: { cp: 30 }, pv: ['e1g1'] }], asked }, profile });
    const lineMoves = ['d8g5', 'c4f7', 'e8d8', 'e5g4'];
    expect([...askedLineMoves(why([nxe5]))]).toEqual(lineMoves);
    const arrows = ['f3e5', ...lineMoves].map((uci) => ({ uci, brush: 'blue' as const }));
    const out = guardReply(why([nxe5]), reply({ moves: ['f3e5', ...lineMoves, 'd8h4'], arrows }));
    expect(out.moves).toEqual(['f3e5', ...lineMoves]);
    // The board shows the position before the line: Bxf7+ would read as a move to play now, and Kd8 isn't legal there.
    expect(out.arrows).toEqual([{ from: 'f3', to: 'e5', brush: 'blue' }]);
    // 4… Qh4 is legal after 4. Nxe5 but not in the Engine's line.
    expect(out.stripped).toEqual(["move d8h4 is not in the Engine's output", ...lineMoves.map((uci) => `arrow ${uci} is not in the Engine's output`)]);
    // Without the question, the same line gets nothing past the guard.
    expect(guardReply(why(), reply({ moves: lineMoves })).moves).toEqual([]);
  });

  it('strips every move and arrow from a Hint', () => {
    const hint = buildBrief({ ask: { ...ask, job: 'hint' }, profile });
    const best = hint.candidates[0]?.uci as string;
    const out = guardReply(hint, reply({ moves: [best], arrows: [{ uci: best, brush: 'green' }], highlights: ['e4'] }));
    expect(out).toMatchObject({ moves: [], arrows: [], highlights: [] });
  });

  it('keeps a note only when one is allowed, as one short line', () => {
    expect(guardReply(brief, reply({ note: 'Rushes the bishop sacrifice' })).note).toBeNull();
    const allowed = buildBrief({ ask: { ...ask, allowNote: true }, profile });
    const note = guardReply(allowed, reply({ note: `Rushes\n the bishop ${'a'.repeat(200)}` })).note as string;
    expect(note.length).toBeLessThanOrEqual(140);
    expect(note).not.toContain('\n');
  });
});
