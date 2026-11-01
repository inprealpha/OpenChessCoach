// A game's Review pitched at the rating its record gives, and a game the owner didn't play told
// about by colour (#33).
import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import { SAMPLE_GAME_PGN } from '@chess-coach/shared/sample-game';
import { gameRatings, ownersGame, pgnHeaders, poolOf } from '../src/game-pitch.ts';
import { updateProfile } from '../src/profile.ts';
import { FakeTemptingMoves } from '../src/tempting-moves/fake.ts';
import type { TemptingMovesRequest } from '../src/tempting-moves/port.ts';
import { TemptingMovesService } from '../src/tempting-moves/service.ts';
import { client, instance, rows } from './helpers.ts';

/** A Lichess game between two named players, with their ratings and a time control. */
function lichessPgn(white: string, black: string, whiteElo: string, blackElo: string, timeControl = '600+0'): string {
  return `[Event "Rated game"]\n[Site "https://lichess.org/abcd1234"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n[WhiteElo "${whiteElo}"]\n[BlackElo "${blackElo}"]\n[TimeControl "${timeControl}"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n`;
}

/** A fake tempting-moves side that records the ratings Maia-3 would be given. */
function recordingTempting(): { service: TemptingMovesService; requests: TemptingMovesRequest[] } {
  const fake = new FakeTemptingMoves();
  return { service: TemptingMovesService.fake(fake), requests: fake.requests };
}

function briefs(app: Awaited<ReturnType<typeof instance>>, job: string): Brief[] {
  return rows<{ brief: string }>(app, 'SELECT brief FROM coach_calls WHERE job = ? ORDER BY id', job).map((r) => JSON.parse(r.brief) as Brief);
}

describe("a game's rating pool", () => {
  it("follows each site's rule: the base time plus 40 times the increment", () => {
    expect(poolOf('lichess', '15+0')).toBe('ultraBullet');
    expect(poolOf('lichess', '60+1')).toBe('bullet');
    expect(poolOf('lichess', '300+3')).toBe('blitz');
    expect(poolOf('lichess', '600+0')).toBe('rapid');
    expect(poolOf('lichess', '1800+30')).toBe('classical');
    expect(poolOf('lichess', '-')).toBe('correspondence');
    expect(poolOf('chesscom', '60')).toBe('chess_bullet');
    expect(poolOf('chesscom', '180+2')).toBe('chess_blitz');
    // 2 | 12 is 10 minutes in all: rapid on chess.com.
    expect(poolOf('chesscom', '120+12')).toBe('chess_rapid');
    expect(poolOf('chesscom', '1/86400')).toBe('chess_daily');
    expect(poolOf('chesscom', undefined)).toBeUndefined();
  });

  it("reads each side's rating, the site and the pool from the game's record", () => {
    // The sample game names Lichess and its pool in its Event.
    expect(gameRatings({ source: 'sample', pgn: SAMPLE_GAME_PGN })).toEqual({ white: 1456, black: 1645, site: 'lichess', pool: 'classical' });
    expect(gameRatings({ source: 'lichess', pgn: lichessPgn('a', 'b', '?', '1500', '180+2') })).toEqual({ black: 1500, site: 'lichess', pool: 'blitz' });
    expect(gameRatings({ source: 'chesscom', pgn: '[Site "Chess.com"]\n[WhiteElo "1200"]\n[BlackElo "1250"]\n[TimeControl "600"]\n\n1. e4 1-0' })).toEqual({
      white: 1200, black: 1250, site: 'chesscom', pool: 'chess_rapid',
    });
    // An Engine Game's PGN is the app's own.
    expect(gameRatings({ source: 'engine', pgn: '[WhiteElo "1500"]\n\n1. e4 *' })).toEqual({});
    expect(pgnHeaders('[White "a \\"b\\""]\n[Black "c"]\n\n1. e4 { [WhiteElo "9"] } e5')).toEqual({ White: 'a "b"', Black: 'c' });
  });

  it("takes a game as the owner's unless their account's site shows it is someone else's", () => {
    const friends = { white: 'Friend', black: 'Rival' };
    const linked = { ratingSource: { site: 'lichess' as const, username: 'owner' } };
    expect(ownersGame(linked, { source: 'lichess', ...friends })).toBe(false);
    expect(ownersGame(linked, { source: 'lichess', white: 'Rival', black: 'OWNER' })).toBe(true);
    // No account, another site, or a pasted PGN: the app can't tell, so it is the owner's as before.
    expect(ownersGame({ ratingSource: null }, { source: 'lichess', ...friends })).toBe(true);
    expect(ownersGame({ ratingSource: { site: 'chesscom', username: 'owner' } }, { source: 'lichess', ...friends })).toBe(true);
    expect(ownersGame(linked, { source: 'pgn', ...friends })).toBe(true);
  });
});

describe('a Review pitched at the game’s rating', () => {
  it("uses the Player Profile's level until the Player turns it on, then the game's rating for the side reviewed", async () => {
    const { service, requests } = recordingTempting();
    const app = await instance({ temptingMoves: service });
    const c = await client(app);
    // The seed's game 1 is the sample game: White 1456, Black 1645, the Player as White.
    expect((await c.request('profile.update', { level: 'club' })).levelFromGames).toBe(false);
    await c.request('review.start', { gameId: 1 });
    for (const b of [...briefs(app, 'review-overview'), ...briefs(app, 'review-moment')]) {
      expect(b.level).toBe('club');
      expect(b).not.toHaveProperty('rating');
      expect(b).not.toHaveProperty('ownGame');
    }
    // Maia-3 gets the Player Profile's rating, here none linked: the middle of the pool.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.rating === 1500 && r.opponentRating === 1500)).toBe(true);

    const on = await c.request('profile.update', { levelFromGames: true });
    expect(on).toMatchObject({ level: 'club', levelFromGames: true });
    await c.request('games.setSide', { gameId: 1, playerSide: 'black', dropReview: true });
    app.app.db.prepare('DELETE FROM coach_calls').run();
    requests.length = 0;
    await c.request('review.start', { gameId: 1 });
    const pitched = [...briefs(app, 'review-overview'), ...briefs(app, 'review-moment')];
    expect(pitched.length).toBeGreaterThan(1);
    // Black's 1645 in this game: casual (1400 to 1799).
    for (const b of pitched) expect(b).toMatchObject({ level: 'casual', rating: 1645, playerSide: 'black' });
    // A classical game's rating doesn't convert soundly to Maia-3's blitz scale (ADR 0011): 1500.
    expect(requests.every((r) => r.rating === 1500)).toBe(true);
  });

  it("gives Maia-3 the game's ratings when they convert, the opponent's too", async () => {
    const { service, requests } = recordingTempting();
    const app = await instance({ seed: 'empty', temptingMoves: service });
    const c = await client(app);
    await c.request('profile.update', { levelFromGames: true });
    // A Lichess blitz game, as it is on Maia-3's scale.
    const { game } = await c.request('games.importPgn', { pgn: lichessPgn('me', 'them', '1320', '1410', '180+2'), playerSide: 'white' });
    await c.request('review.start', { gameId: game.id });
    for (const b of briefs(app, 'review-moment')) expect(b).toMatchObject({ level: 'beginner', rating: 1320 });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r).toMatchObject({ rating: 1320, opponentRating: 1410 });
  });

  it("pitches a Why Question about the game as its Review, and no other", async () => {
    const app = await instance();
    const c = await client(app);
    await c.request('profile.update', { level: 'club', levelFromGames: true });
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5';
    await c.request('coach.ask', { job: 'why', fen, recentMoves: [], playerSide: 'white', moveUci: 'd2d4', gameId: 1 });
    await c.request('coach.ask', { job: 'why', fen, recentMoves: [], playerSide: 'white', moveUci: 'd2d4' });
    // A game that isn't in the game list is no game to pitch at.
    await c.request('coach.ask', { job: 'why', fen, recentMoves: [], playerSide: 'white', moveUci: 'd2d4', gameId: 999 });
    expect(briefs(app, 'why').map((b) => [b.level, b.rating ?? null])).toEqual([['casual', 1456], ['club', null], ['club', null]]);
  });
});

describe("a game the owner didn't play", () => {
  it('is told about by colour, and leaves no note in the Player Profile', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    // The owner's account is on Lichess; a friend's game names neither side by it.
    updateProfile(app.app.db, { rating: { site: 'lichess', username: 'Owner', rating: 1200, pool: 'rapid' } });
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    const friends = rows<{ id: number }>(app, "SELECT id FROM games WHERE source_id = 'wvkkfh56'")[0]?.id as number;
    app.coach.script({ kind: 'reply', reply: { note: 'Leaves pieces loose.' } });
    const review = await c.request('review.start', { gameId: friends });
    // CoachVerify had Black in this game: the Review follows Black, named by colour.
    expect(review.overview?.text).toMatch(/^Black's Move Grades: .*\. White's: /);
    for (const b of [...briefs(app, 'review-overview'), ...briefs(app, 'review-moment')]) expect(b).toMatchObject({ ownGame: false, playerSide: 'black', allowNote: false });
    expect(review.moments.every((m) => m.explanation.startsWith('Here Black played'))).toBe(true);
    expect(rows(app, 'SELECT * FROM coach_notes')).toEqual([]);
    // Nor do its Move Grades count into the owner's Player Profile, and dropping it takes none back,
    // even once the account no longer tells the game apart.
    expect(rows(app, 'SELECT * FROM grade_counts')).toEqual([]);
    expect(rows(app, 'SELECT counted FROM reviews WHERE game_id = ?', friends)).toEqual([{ counted: 0 }]);
    const own = rows<{ id: number }>(app, "SELECT id FROM games WHERE source_id = 'iinnkv77'")[0]?.id as number;
    updateProfile(app.app.db, { rating: { site: 'lichess', username: 'CoachVerify', rating: 1500, pool: 'rapid' } });
    await c.request('review.start', { gameId: own });
    const counted = rows(app, 'SELECT * FROM grade_counts');
    expect(counted.length).toBeGreaterThan(0);
    await c.request('games.delete', { gameId: friends });
    expect(rows(app, 'SELECT * FROM grade_counts')).toEqual(counted);
  });

  it("is the owner's own game when it names their account", async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    updateProfile(app.app.db, { rating: { site: 'lichess', username: 'coachverify', rating: 1500, pool: 'rapid' } });
    await c.request('games.importUser', { site: 'lichess', username: 'CoachVerify' });
    const own = rows<{ id: number }>(app, "SELECT id FROM games WHERE source_id = 'wvkkfh56'")[0]?.id as number;
    const review = await c.request('review.start', { gameId: own });
    expect(review.overview?.text).toMatch(/^Your Move Grades: /);
    for (const b of briefs(app, 'review-moment')) expect(b).not.toHaveProperty('ownGame');
  });
});
