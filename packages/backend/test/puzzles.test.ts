// Puzzle attempts and the Player Profile's "solved first time" count.
import { describe, expect, it } from 'vitest';
import { client, instance, rows } from './helpers.ts';

describe('Puzzle attempts', () => {
  it('count each Puzzle once, by its first attempt, however often the Player tries it again', async () => {
    const app = await instance();
    const c = await client(app);
    const missed = { opening: 'two-knights-defence', solved: false, mistakes: 0 };
    expect(await c.request('puzzles.record', { puzzleId: 'aaa01', ...missed })).toEqual({ attempted: 1, solved: 0 });
    expect(await c.request('puzzles.record', { puzzleId: 'bbb02', ...missed })).toEqual({ attempted: 2, solved: 0 });
    // Tried again from the missed queue and solved cleanly: still missed first time, and still one Puzzle.
    expect(await c.request('puzzles.record', { puzzleId: 'aaa01', ...missed, solved: true })).toEqual({ attempted: 2, solved: 0 });
    expect((await c.request('profile.get', {})).puzzles).toEqual({ attempted: 2, solved: 0 });
    // The desktop keeps only the first attempt.
    expect(rows(app, 'SELECT puzzle_id, solved FROM puzzle_attempts ORDER BY id')).toEqual([
      { puzzle_id: 'aaa01', solved: 0 },
      { puzzle_id: 'bbb02', solved: 0 },
    ]);
  });

  it('count retries an install already holds, say from a second device, by each Puzzle’s first attempt', async () => {
    const app = await instance();
    const insert = app.app.db.prepare('INSERT INTO puzzle_attempts (puzzle_id, opening, solved, mistakes, attempted_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('aaa01', 'italian-game', 0, 2, '2026-10-01T10:00:00.000Z');
    insert.run('aaa01', 'italian-game', 1, 0, '2026-10-02T10:00:00.000Z');
    insert.run('bbb02', 'italian-game', 1, 0, '2026-10-02T10:01:00.000Z');
    const c = await client(app);
    expect((await c.request('profile.get', {})).puzzles).toEqual({ attempted: 2, solved: 1 });
  });
});
