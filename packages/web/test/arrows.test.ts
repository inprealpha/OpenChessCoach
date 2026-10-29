// A Lesson's Coach arrows show no move for the Player but the one on the board: another, even the
// Engine's top choice, may be the answer to the Lesson's next decision.
import { describe, expect, it } from 'vitest';
import { playUci } from '@chess-coach/shared/chess';
import type { Arrow } from '@chess-coach/shared/coach/types';
import { lessonArrows, lessonHighlights } from '../src/lib/arrows.ts';

const arrow = (uci: string, brush: Arrow['brush']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), brush });

describe('a Lesson’s Coach arrows', () => {
  // 1. e4 e5, and White plays 2. d4 where the Engine's top choice is 2. Nf3.
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  const after = playUci(fen, 'd2d4')!.fenAfter;

  it('keep the move played and the opponent’s replies, and drop another move for the Player', () => {
    const arrows = [arrow('g1f3', 'green'), arrow('d2d4', 'blue'), arrow('e5d4', 'yellow'), arrow('f1c4', 'blue')];
    expect(lessonArrows(arrows, after, 'd2d4', 'white')).toEqual([arrow('d2d4', 'blue'), arrow('e5d4', 'yellow')]);
  });

  it('work for a Player who plays Black, and for a promotion', () => {
    const black = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const played = playUci(black, 'e7e5')!.fenAfter;
    expect(lessonArrows([arrow('d7d5', 'green'), arrow('e7e5', 'green'), arrow('g1f3', 'yellow')], played, 'e7e5', 'black')).toEqual([
      arrow('e7e5', 'green'),
      arrow('g1f3', 'yellow'),
    ]);
    const promoting = '8/4P3/8/8/8/8/k7/4K3 w - - 0 1';
    expect(lessonArrows([arrow('e7e8', 'green')], playUci(promoting, 'e7e8q')!.fenAfter, 'e7e8q', 'white')).toEqual([arrow('e7e8', 'green')]);
  });
});

describe('a Lesson’s Coach highlights', () => {
  it('keep the move played and drop every square a move of the Player’s could go to', () => {
    // 1. e4 e5 2. d4: Nf3, Bc4 and dxe5 are all moves White could make next.
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
    const after = playUci(fen, 'd2d4')!.fenAfter;
    expect(lessonHighlights(['d4', 'd2', 'f3', 'c4', 'e5', 'f7'], after, 'd2d4', 'white')).toEqual(['d4', 'd2', 'f7']);
  });

  it('cannot mark the mating square before the Player moves', () => {
    // King and queen against king: Qg7# or Qd8#. The king's square and a far corner may stay.
    const fen = '6k1/8/5QK1/8/8/8/8/8 w - - 0 1';
    expect(lessonHighlights(['g7', 'd8', 'g8', 'b1'], fen, undefined, 'white')).toEqual(['g8', 'b1']);
  });

  it('after a move that isn’t the Lesson’s, drop every square the Player could go to when trying again', () => {
    // The Lesson's move is Nxe5; the Player played Ng5 instead and tries again from the position before it.
    const node = '4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1';
    const after = playUci(node, 'f3g5')!.fenAfter;
    expect(lessonHighlights(['e5', 'g5', 'f3', 'a8'], after, 'f3g5', 'white', node)).toEqual(['g5', 'f3', 'a8']);
  });

  it('keep only the move’s own squares after a check, when the Player’s next move can’t be known', () => {
    const after = playUci('6k1/8/5QK1/8/8/8/8/8 w - - 0 1', 'f6f7')!.fenAfter;
    expect(lessonHighlights(['f7', 'f6', 'h8', 'a1'], after, 'f6f7', 'white')).toEqual(['f7', 'f6']);
  });
});
