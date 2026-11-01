import { MAX_QUESTION_LENGTH, MODEL_JOBS } from '@chess-coach/shared/protocol';
import { isValidFen } from '@chess-coach/shared/chess';
import { AppError } from '../errors.ts';
import { gamePitch, type GamePitchFor } from '../game-pitch.ts';
import { findGame } from '../games.ts';
import { withReviewScores } from '../reviews.ts';
import { guessTempting, historyFromSans, withTempting } from '../tempting-moves/ask.ts';
import { playerMaiaRating } from '../tempting-moves/rating.ts';
import type { Side } from '@chess-coach/shared/chess';
import type { Db } from '../db.ts';
import type { HandlerMap } from './index.ts';

export const coachHandlers: HandlerMap<'coach.ask'> = {
  'coach.ask': async (req, { app, delta, signal }) => {
    // A Review's overview is the desktop's own: it is made from a Review, never asked for here.
    if (!MODEL_JOBS.includes(req.job)) throw new AppError('bad-request', 'Unknown Coach job.');
    if (typeof req.fen !== 'string' || !isValidFen(req.fen)) throw new AppError('bad-request', 'The position is not valid.');
    if (req.moveUci !== undefined && typeof req.moveUci !== 'string') throw new AppError('bad-request', 'The move is not valid.');
    if (req.question !== undefined && typeof req.question !== 'string') throw new AppError('bad-request', 'The question is not valid.');
    if (req.question && req.question.trim().length > MAX_QUESTION_LENGTH) {
      throw new AppError('bad-request', `A question can be at most ${MAX_QUESTION_LENGTH} characters.`);
    }
    // Check the Coach can answer before spending the Engine's time on the facts.
    await app.coach.assertAvailable();
    const playerSide = req.playerSide === 'white' || req.playerSide === 'black' ? req.playerSide : undefined;
    // A Why Question about a game in the game list is pitched as its Review is (#33).
    const { pitch, maia } = pitchOf(app.db, req.gameId, playerSide);
    // The moves many players would reach for (ADR 0011), guessed while the Engine works out the facts.
    const guess = guessTempting(req.job, {
      service: app.temptingMoves,
      fen: req.fen,
      playerSide,
      ...maia,
      history: historyFromSans(req.fen, Array.isArray(req.recentMoves) ? req.recentMoves : []),
      signal,
    });
    const facts = withReviewScores(app.db, req.gameId, { ...(await app.desktopEngine.factsFor(req)), ...(pitch ? { pitch } : {}) });
    const ask = await withTempting(facts, guess, app.desktopEngine);
    return app.coach.ask(ask, (text) => delta(text), { signal, engine: app.desktopEngine, onStatus: (status) => delta('', undefined, status) });
  },
};

/**
 * The pitch of the game a Why Question is about, for the side it asks as, or the Player Profile's
 * when it names no game in the game list.
 */
function pitchOf(db: Db, gameId: unknown, side: Side | undefined): GamePitchFor {
  const game = typeof gameId === 'number' ? findGame(db, gameId) : undefined;
  return game ? gamePitch(db, game, side) : { maia: { rating: playerMaiaRating(db) } };
}
