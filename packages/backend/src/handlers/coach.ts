import { COACH_JOBS, MAX_QUESTION_LENGTH } from '@chess-coach/shared/protocol';
import { isValidFen } from '@chess-coach/shared/chess';
import { AppError } from '../errors.ts';
import { withReviewScores } from '../reviews.ts';
import type { HandlerMap } from './index.ts';

export const coachHandlers: HandlerMap<'coach.ask'> = {
  'coach.ask': async (req, { app, delta, signal }) => {
    if (!COACH_JOBS.includes(req.job)) throw new AppError('bad-request', 'Unknown Coach job.');
    if (typeof req.fen !== 'string' || !isValidFen(req.fen)) throw new AppError('bad-request', 'The position is not valid.');
    if (req.moveUci !== undefined && typeof req.moveUci !== 'string') throw new AppError('bad-request', 'The move is not valid.');
    if (req.question !== undefined && typeof req.question !== 'string') throw new AppError('bad-request', 'The question is not valid.');
    if (req.question && req.question.trim().length > MAX_QUESTION_LENGTH) {
      throw new AppError('bad-request', `A question can be at most ${MAX_QUESTION_LENGTH} characters.`);
    }
    // Check the Coach can answer before spending the Engine's time on the facts.
    await app.coach.assertAvailable();
    const ask = withReviewScores(app.db, req.gameId, await app.desktopEngine.factsFor(req));
    return app.coach.ask(ask, (text) => delta(text), signal);
  },
};
