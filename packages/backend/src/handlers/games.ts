import { GAMES_LIST_MAX, GAMES_PAGE_SIZE, type GameSummary } from '@chess-coach/shared/protocol';
import { AppError } from '../errors.ts';
import { transaction, type Db } from '../db.ts';
import { countGames, deleteGame, getGame, importedThrough, importPgn, importSample, importSiteGame, listGames, playingGames, saveEngineGame, setImportedThrough, setPlayerSide, setPlaying } from '../games.ts';
import { fetchGamesSince, type SiteGame } from '../imports/sites.ts';
import { dropReview, getReview, reviewInProgress, startReview } from '../reviews.ts';
import type { HandlerMap } from './index.ts';

export const gameHandlers: HandlerMap<
  | 'games.importPgn'
  | 'games.importSample'
  | 'games.importUser'
  | 'games.list'
  | 'games.get'
  | 'games.setSide'
  | 'games.delete'
  | 'games.saveEngineGame'
  | 'games.syncOffline'
  | 'review.start'
  | 'review.get'
> = {
  'games.importPgn': async (req, { app }) => {
    if (typeof req.pgn !== 'string') throw new AppError('bad-request', 'Paste a PGN first.');
    if (req.pgn.length > 200_000) throw new AppError('invalid-pgn', 'That PGN is too long for one game.');
    return importPgn(app.db, app.clock, req.pgn, req.playerSide);
  },

  'games.importSample': async (_req, { app }) => importSample(app.db, app.clock),

  'games.importUser': async (req, { app, progress, signal }) => {
    if (req.site !== 'lichess' && req.site !== 'chesscom') throw new AppError('bad-request', 'Pick Lichess or chess.com.');
    const site = req.site;
    // The first import brings the whole history; later ones carry on from where the last stopped.
    const since = importedThrough(app.db, site, req.username);
    let imported = 0;
    let duplicates = 0;
    let skippedUnfinished = 0;
    let unreadable = 0;
    let fetched = 0;
    // Games arrive oldest first, so the import has reached the newest game so far, unless a
    // chess.com game still being played came before it: that one must be fetched again next time.
    let newest = since;
    let firstUnfinished = Infinity;
    try {
      const onBatch = (batch: SiteGame[], unread: number, rechecked: string[]) => {
        // Counted once the batch is saved, so a batch that fails counts nothing.
        const counts = { imported: 0, duplicates: 0, skippedUnfinished: 0 };
        let batchNewest = newest;
        let batchFirstUnfinished = firstUnfinished;
        transaction(app.db, () => {
          for (const id of rechecked) setPlaying(app.db, site, req.username, id, false);
          for (const g of batch) {
            if (!g.finished) {
              // Never import a game that is still going (no help in live games).
              counts.skippedUnfinished++;
              // Lichess can be asked for it again by id, so the import moves past it; chess.com
              // can't, so the import stops just before it.
              if (g.site === 'lichess') {
                setPlaying(app.db, site, req.username, g.sourceId, true);
                if (!rechecked.length) batchNewest = Math.max(batchNewest, g.time);
              } else batchFirstUnfinished = Math.min(batchFirstUnfinished, g.time);
              continue;
            }
            // A game asked for again by id is older than the import point already reached.
            if (!rechecked.length) batchNewest = Math.max(batchNewest, g.time);
            setPlaying(app.db, site, req.username, g.sourceId, false);
            const result = importSiteGame(app.db, app.clock, g.site, g.sourceId, g.game, req.username, rebuildPgn(g.game.headers, g.game.sans, g.game.result));
            // A game the Player deleted counts as neither.
            if (result === 'duplicate') counts.duplicates++;
            else if (result === 'imported') counts.imported++;
          }
          const through = Math.min(batchNewest, batchFirstUnfinished - 1);
          if (through > since) setImportedThrough(app.db, site, req.username, through);
        });
        newest = batchNewest;
        firstUnfinished = batchFirstUnfinished;
        imported += counts.imported;
        duplicates += counts.duplicates;
        skippedUnfinished += counts.skippedUnfinished;
        unreadable += unread;
        fetched += batch.length + unread;
        progress(fetched, 0);
      };
      await fetchGamesSince({ fetch: app.fetch, signal }, site, req.username, since, onBatch, playingGames(app.db, site, req.username));
    } catch (err) {
      // What was fetched before the failure is saved, and the next import carries on from there.
      if (err instanceof AppError && imported) {
        throw new AppError(err.code, `${err.message} The ${imported} ${imported === 1 ? 'game' : 'games'} fetched before that ${imported === 1 ? 'is' : 'are'} in your list, and fetching again carries on from there.`);
      }
      throw err;
    }
    return { imported, duplicates, skippedUnfinished, unreadable };
  },

  'games.list': async (req, { app }) => {
    const offset = req.offset ?? 0;
    const limit = req.limit ?? GAMES_PAGE_SIZE;
    if (!Number.isInteger(offset) || offset < 0) throw new AppError('bad-request', 'The game list starts at 0 or later.');
    if (!Number.isInteger(limit) || limit < 1 || limit > GAMES_LIST_MAX) throw new AppError('bad-request', `Ask for 1 to ${GAMES_LIST_MAX} games at a time.`);
    return { games: listGames(app.db, offset, limit), total: countGames(app.db) };
  },

  'games.get': async (req, { app }) => getGame(app.db, Number(req.gameId)),

  'games.setSide': async (req, { app }) => {
    const gameId = Number(req.gameId);
    if (req.playerSide !== 'white' && req.playerSide !== 'black') throw new AppError('bad-request', 'Pick White or Black.');
    const game = getGame(app.db, gameId);
    // The side it already has: its Review still applies.
    if (game.playerSide === req.playerSide) return setPlayerSide(app.db, gameId, req.playerSide);
    notReviewing(app.db, gameId);
    if (game.hasReview && req.dropReview !== true) {
      throw new AppError('needs-confirm', 'This game has a Review, which goes if you change its side, with its Move Grades in your Player Profile.');
    }
    return transaction(app.db, () => {
      dropReview(app.db, gameId);
      return setPlayerSide(app.db, gameId, req.playerSide);
    });
  },

  'games.delete': async (req, { app }) => {
    const gameId = Number(req.gameId);
    getGame(app.db, gameId);
    notReviewing(app.db, gameId);
    transaction(app.db, () => {
      dropReview(app.db, gameId);
      deleteGame(app.db, gameId);
    });
    return { total: countGames(app.db) };
  },

  'games.saveEngineGame': async (req, { app }) => saveEngineGame(app.db, app.clock, req.game),

  'games.syncOffline': async (req, { app }) => {
    if (!Array.isArray(req.games)) throw new AppError('bad-request', 'Expected a list of games.');
    const saved: GameSummary[] = [];
    let duplicates = 0;
    for (const record of req.games) {
      const result = saveEngineGame(app.db, app.clock, record);
      if (result.duplicate) duplicates++;
      saved.push(result.game);
    }
    return { saved, duplicates };
  },

  // A Review outlives the request that asked for it: a closed tab, a reload or a dropped
  // connection leaves it to finish and be saved, and asking again joins it. It stops only when
  // the desktop app does.
  'review.start': async (req, { app, delta, progress }) =>
    startReview({ db: app.db, clock: app.clock, coach: app.coach, engine: app.desktopEngine }, Number(req.gameId), delta, progress, app.stopping),

  'review.get': async (req, { app }) => {
    const gameId = Number(req.gameId);
    const review = getReview(app.db, gameId);
    return { review, beingMade: !review && reviewInProgress(app.db, gameId) };
  },
};

/** A game whose Review is being made can't change under it: that Review would count the wrong moves. */
function notReviewing(db: Db, gameId: number): void {
  if (reviewInProgress(db, gameId)) throw new AppError('bad-request', 'This game’s Review is being made right now. Try again once it’s done.');
}

function rebuildPgn(headers: Record<string, string>, sans: string[], result: string): string {
  const head = Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`).join('\n');
  const body: string[] = [];
  sans.forEach((s, i) => {
    if (i % 2 === 0) body.push(`${i / 2 + 1}.`);
    body.push(s);
  });
  return `${head}\n\n${body.join(' ')} ${result}\n`;
}
