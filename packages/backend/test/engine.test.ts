// The desktop's Engine (ADR 0007).
import { describe, expect, it } from 'vitest';
import { outcomeOfLine, playLine } from '@chess-coach/shared/chess';
import { createNodeEngine } from '../src/engine/node-engine.ts';
import { EngineService } from '../src/engine/service.ts';
import { VERIFY_ENGINE } from '../src/verify/instance.ts';

describe('the desktop’s Engine', () => {
  it('loads each Stockfish build once per process, whatever the thread count', async () => {
    const [single, multi] = [createNodeEngine(1), createNodeEngine(2)];
    expect(createNodeEngine(1)).toBe(single);
    expect(createNodeEngine(3)).toBe(multi);
    expect(createNodeEngine(4)).toBe(multi);
    expect(multi).not.toBe(single);
    await Promise.all([single, multi]);
  });

  it('with the game’s moves, does not walk into a threefold repetition when it is better', async () => {
    // A fortress: White is a bishop up, but the bishop can't reach a pawn and no king can pass the
    // pawns, while Black's king shuffles. From the bare position the Engine plays Be2, the third
    // time that position occurs; given the moves so far it sees that, and plays on.
    const start = '4k3/8/3p3p/p1pPp1pP/PpP1PpP1/1P3P2/8/4KB2 w - - 0 1';
    const moves = ['f1d3', 'e8e7', 'd3f1', 'e7e8', 'e1d2', 'e8e7', 'f1e2', 'e7e8', 'd2c2', 'e8e7', 'c2d2', 'e7e8', 'e2f1', 'e8e7'];
    const line = playLine(start, moves);
    const fen = line.at(-1)?.fenAfter as string;
    const engine = await createNodeEngine(1);
    const bare = await engine.bestMove(fen, { skill: 20, depth: 10 });
    expect(outcomeOfLine(start, [...line, ...playLine(fen, [bare])])).toMatchObject({ reason: 'repetition' });
    const seen = await engine.bestMove(fen, { skill: 20, depth: 10, history: { startFen: start, moves } });
    expect(outcomeOfLine(start, [...line, ...playLine(fen, [seen])])).toBeUndefined();
  });

  it('grades the move that draws by threefold repetition from the draw, in a Review', async () => {
    // A queen up after 1. e4 e5 2. Qh5 Qg5 3. Qxg5, White brings a knight home for the third time:
    // the game is drawn, so 7. Ng1 throws the win away, though the bare position still reads +6.
    const moves = ['e2e4', 'e7e5', 'd1h5', 'd8g5', 'h5g5', 'b8c6', 'g1f3', 'c6b8', 'f3g1', 'b8c6', 'g1f3', 'c6b8', 'f3g1'];
    const service = new EngineService(() => createNodeEngine(), VERIFY_ENGINE);
    const last = (await service.gradeGame(moves)).at(-1);
    expect(last).toMatchObject({ ply: 13, san: 'Ng1', playedScore: { cp: 0 }, grade: 'Blunder' });
  });

  it('stops grading a game for a cancelled Review with a cancelled error', async () => {
    const service = new EngineService(() => createNodeEngine(), VERIFY_ENGINE);
    await expect(service.gradeGame(['e2e4', 'e7e5'], undefined, undefined, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('grades a slower mate the Engine sees Good, and keeps the floor when it can’t see the mate', async () => {
    // Ra8 mates at once; Kf6 still mates in 4 and the Engine sees it, so nothing is given away
    // (ADR 0002). With the queen, Kg5 still mates in 5, but at verify depth the Engine reports
    // +10.12, not a mate, so the material floor still applies: the floor only steps aside for a
    // mate the Engine reports.
    const service = new EngineService(() => createNodeEngine(), VERIFY_ENGINE);
    const slower = (await service.grade('7k/8/6K1/8/8/8/8/R7 w - - 0 1', 'g6f6')).move;
    const unseen = (await service.grade('7k/8/6K1/8/8/8/8/1Q6 w - - 0 1', 'g6g5')).move;
    expect([slower.grade, slower.playedScore]).toEqual(['Good', { mate: 4 }]);
    expect([unseen.grade, unseen.playedScore.mate]).toEqual(['Mistake', undefined]);
  });
});
