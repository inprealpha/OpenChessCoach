import { AppError } from '../errors.ts';
import { fetchRating } from '../imports/sites.ts';
import { deleteCoachNote, getProfile, updateProfile, type ProfilePatch } from '../profile.ts';
import type { HandlerMap } from './index.ts';

export const profileHandlers: HandlerMap<'profile.get' | 'profile.update' | 'profile.deleteNote'> = {
  'profile.get': async (_req, { app }) => getProfile(app.db),

  'profile.update': async (req, { app, signal, connected }) => {
    const patch: ProfilePatch = {};
    if (req.level !== undefined) patch.level = req.level;
    if (req.goals !== undefined) {
      if (!Array.isArray(req.goals)) throw new AppError('bad-request', 'Goals must be a list.');
      patch.goals = req.goals.map(String);
    }
    if (req.onboarded !== undefined) patch.onboarded = Boolean(req.onboarded);
    if (req.rating === null) patch.rating = null;
    else if (req.rating) {
      if (req.rating.site !== 'lichess' && req.rating.site !== 'chesscom') throw new AppError('bad-request', 'Pick Lichess or chess.com.');
      const { rating, pool, blitz } = await fetchRating(app.fetch, req.rating.site, req.rating.username, signal);
      patch.rating = { site: req.rating.site, username: req.rating.username.trim(), rating, pool, ...(blitz ? { blitz } : {}) };
    }
    // The app tells the Player a change wasn't saved when its connection is lost, so a closed one
    // saves nothing. Wait a turn first: a desktop waking from sleep reads a message and the close
    // that followed it together.
    await Promise.resolve();
    if (!connected()) throw new AppError('cancelled', 'Not saved: the connection closed first.');
    return updateProfile(app.db, patch);
  },

  'profile.deleteNote': async (req, { app }) => deleteCoachNote(app.db, Number(req.noteId)),
};
