// The real-Coach check's structural rules, each proven against a deliberately broken reply.
import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { CoachRawReply, CoachReply } from '@chess-coach/shared/coach/types';
import { CHECK_MODEL, checkCall, RecordingCoach } from '../real-coach-check.ts';
import type { CoachCall, CoachPort } from '../../packages/backend/src/coach/port.ts';

const AFTER_E4_D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const brief: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: AFTER_E4_D5,
  recentMoves: '1. e4 d5',
  move: { san: 'Nf3', uci: 'g1f3', grade: 'Blunder', evalAfter: '-1.2' },
  candidates: [
    { san: 'exd5', uci: 'e4d5', eval: '+0.40', grade: 'Best', line: 'Qxd5 Nc3' },
    { san: 'Nc3', uci: 'b1c3', eval: '+0.10', grade: 'Inaccuracy', line: 'dxe4 Nxe4' },
  ],
  replies: [{ san: 'dxe4', uci: 'd5e4', eval: '+1.20', grade: 'Best', line: 'Ng5' }],
  maxWords: 40,
  allowNote: false,
  hideMoves: false,
};
const raw: CoachRawReply = { text: '', moves: ['e4d5'], arrows: [], highlights: [], note: null };
const good: CoachReply = {
  text: 'Nf3 leaves the e4 pawn hanging, so dxe4 wins it. Take back first with exd5 and keep the pawn.',
  moves: ['e4d5'],
  arrows: [{ from: 'e4', to: 'd5', brush: 'green' }],
  highlights: [],
  note: null,
  stripped: 0,
  model: 'sonnet',
};
const terms = ['accuracy', 'tutor', 'computer'];
const check = (reply: Partial<CoachReply>, b: Partial<Brief> = {}) => checkCall({ job: 'why', brief: { ...brief, ...b }, raw }, { ...good, ...reply }, terms);

describe('the real-Coach check', () => {
  it('passes a reply whose moves and text all come from the brief', () => {
    expect(check({}).problems).toEqual([]);
  });

  it('fails a move that is not legal, or that the Engine never suggested', () => {
    expect(check({ moves: ['e2e5'] }).problems).toEqual(['the reply shows e2e5, which is not legal here']);
    expect(check({ arrows: [{ from: 'a2', to: 'a4', brush: 'green' }] }).problems).toEqual(['the reply shows a2a4, which the Engine never suggested']);
  });

  it('fails a piece move named in the text that is not in the brief', () => {
    expect(check({ text: 'Bb5+ was the move.' }).problems).toEqual(['the text names Bb5, which is not in the brief']);
  });

  it('fails a Hint that names a move', () => {
    expect(check({ text: 'Think about exd5.', moves: [], arrows: [] }, { job: 'hint', hideMoves: true }).problems).toEqual(['the Hint names the move exd5']);
  });

  it('warns just over the length budget and fails well over it', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    expect(check({ text: words(45) })).toMatchObject({ problems: [], warnings: ['45 words, over the 40-word budget'] });
    expect(check({ text: words(60) }).problems).toEqual(['60 words, over the 40-word budget by more than 25%']);
  });

  it('fails a term CONTEXT.md says to avoid', () => {
    expect(check({ text: 'The computer likes exd5.' }).problems).toEqual(['the text uses "computer", which CONTEXT.md says to avoid']);
  });

  it('runs every call on the latest Haiku, whatever model the job uses in the app', async () => {
    const models: string[] = [];
    const inner: CoachPort = {
      name: 'fake',
      status: async () => ({ state: 'ready' }),
      ask: async (call: CoachCall) => {
        models.push(call.model);
        return raw;
      },
    };
    const coach = new RecordingCoach(inner);
    await coach.ask({ job: 'why', model: 'sonnet', brief }, () => {});
    await coach.ask({ job: 'hint', model: 'haiku', brief }, () => {});
    expect(CHECK_MODEL).toBe('haiku');
    expect(models).toEqual(['haiku', 'haiku']);
    expect(coach.calls.map((c) => c.job)).toEqual(['why', 'hint']);
  });
});
