// The main menu offers Continue your game only for an Engine Game this device can carry on with.
import { describe, expect, it } from 'vitest';
import { continuable } from '../src/lib/game-in-progress.ts';

const saved = (over: Record<string, unknown>) => ({ clientId: 'x', playerSide: 'white', strength: 2, moves: [], grades: [], live: false, startedAt: '2026-10-25T00:00:00Z', ...over });
const scholarsMate = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'];

describe('a saved Engine Game to continue', () => {
  it('gives the side and the move number the game is at, as the move list counts them', () => {
    expect(continuable(saved({ moves: [] }))).toEqual({ playerSide: 'white', moveNumber: 1 });
    expect(continuable(saved({ playerSide: 'black', moves: ['e2e4'] }))).toEqual({ playerSide: 'black', moveNumber: 1 });
    expect(continuable(saved({ moves: ['e2e4', 'd7d5', 'e4d5', 'd8d5'] }))).toEqual({ playerSide: 'white', moveNumber: 3 });
  });

  it.each([
    ['a game with its result', saved({ moves: scholarsMate, result: '1-0', termination: 'checkmate' })],
    // The app closed after the last move was saved but before the result was.
    ['a checkmate on the board with no result yet', saved({ moves: scholarsMate })],
    ['the Player checkmated, no result yet', saved({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] })],
    ['a side that is not White or Black', saved({ playerSide: 'red', moves: ['e2e4'] })],
    ['a move that cannot be played', saved({ moves: ['e2e5', 'e7e5'] })],
    ['moves that are not a list of moves', saved({ moves: 'e2e4' })],
    ['a move that is not text', saved({ moves: ['e2e4', 7] })],
    ['something that is not a game', 'garbage'],
    ['nothing', undefined],
  ])('is not offered for %s', (_name, value) => {
    expect(continuable(value)).toBeNull();
  });
});
