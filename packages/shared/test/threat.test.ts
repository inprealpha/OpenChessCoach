// Threats: the opponent's best move if they could move now (a null-move search), counted only when
// it is forcing (a capture, a check or a promotion) and would cost the side to move at least an
// Inaccuracy's worth of winning chances. The Engine here
// answers from a script; packages/backend/test/threat.test.ts runs the golden positions on the real
// Engine at verify mode's depth.
import { describe, expect, it } from 'vitest';
import type { Analysis, Score } from '../src/engine.ts';
import { findThreat } from '../src/threat.ts';

// 1.e4 e5 2.Qh5 Nc6 3.Bc4, Black to move: White threatens Qxf7#.
const SCHOLAR = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
// The same position with White to move, as the Engine is asked about it.
const SCHOLAR_WHITE_TO_MOVE = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 3 3';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** An Engine that answers each position with one scored line. */
function scripted(answers: Record<string, { pv: string[]; score: Score }>): { analyse: (fen: string) => Promise<Analysis>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    analyse: async (fen) => {
      asked.push(fen);
      const a = answers[fen];
      if (!a) throw new Error(`Not scripted: ${fen}`);
      return { fen, depth: 10, lines: [{ ...a, depth: 10 }] };
    },
  };
}

describe('finding a threat', () => {
  it('asks the Engine about the position with the opponent to move, and names their move in it', async () => {
    const engine = scripted({
      [SCHOLAR]: { pv: ['g7g6'], score: { cp: -30 } },
      [SCHOLAR_WHITE_TO_MOVE]: { pv: ['h5f7'], score: { mate: 1 } },
    });
    const threat = await findThreat(engine.analyse, SCHOLAR);
    expect(engine.asked).toEqual([SCHOLAR, SCHOLAR_WHITE_TO_MOVE]);
    expect(threat).toMatchObject({ uci: 'h5f7', san: 'Qxf7#', side: 'white', pv: ['h5f7'], score: { mate: 1 } });
    // Letting a mate in one happen costs nearly all of Black’s winning chances.
    expect(threat?.winLoss).toBeGreaterThan(0.85);
  });

  it('returns none when the opponent’s best move costs less than an Inaccuracy’s worth', async () => {
    // Passing costs a quarter of a pawn: under the Inaccuracy threshold of 0.1 winning chances.
    const engine = scripted({
      [SCHOLAR]: { pv: ['g7g6'], score: { cp: 0 } },
      [SCHOLAR_WHITE_TO_MOVE]: { pv: ['h5f7'], score: { cp: 25 } },
    });
    expect(await findThreat(engine.analyse, SCHOLAR)).toBeUndefined();
  });

  it('counts a cost just past an Inaccuracy’s worth as a threat', async () => {
    // 55 centipawns is just past 0.1 winning chances from equal.
    const engine = scripted({
      [SCHOLAR]: { pv: ['g7g6'], score: { cp: 0 } },
      [SCHOLAR_WHITE_TO_MOVE]: { pv: ['h5f7'], score: { cp: 55 } },
    });
    expect(await findThreat(engine.analyse, SCHOLAR)).toMatchObject({ uci: 'h5f7' });
  });

  it('returns none when the opponent’s best move is a quiet one, whatever the free move is worth', async () => {
    // The start position with Black to move gets 1...e5 in for free: worth more than an
    // Inaccuracy in the opening, but it is a tempo, not a threat.
    const engine = scripted({
      [START]: { pv: ['e2e4'], score: { cp: 38 } },
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1': { pv: ['e7e5'], score: { cp: 38 } },
    });
    expect(await findThreat(engine.analyse, START)).toBeUndefined();
  });

  it('returns none, without asking the Engine, when the side to move is in check', async () => {
    // 1.e4 f6 2.d4 g5 3.Qh5+
    const engine = scripted({});
    expect(await findThreat(engine.analyse, 'rnbqkbnr/ppppp2p/5p2/6pQ/3PP3/8/PPP2PPP/RNB1KBNR b KQkq - 1 3')).toBeUndefined();
    expect(engine.asked).toEqual([]);
  });

  it('returns none when the game is over', async () => {
    const engine = scripted({});
    // Fool's mate: White is checkmated.
    expect(await findThreat(engine.analyse, 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toBeUndefined();
    expect(engine.asked).toEqual([]);
  });

  it('drops an en passant square that only the side to move could use', async () => {
    // 1.e4 d5 2.e5 f5: White could take en passant on f6; Black, moving instead, cannot.
    const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
    const engine = scripted({
      [fen]: { pv: ['e5f6'], score: { cp: 40 } },
      'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3': { pv: ['d8d7'], score: { cp: -40 } },
    });
    expect(await findThreat(engine.analyse, fen)).toBeUndefined();
  });
});
