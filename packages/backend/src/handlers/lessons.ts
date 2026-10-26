import type { LessonProgress } from '@chess-coach/shared/protocol';
import { iso } from '../clock.ts';
import { all, one } from '../db.ts';
import { AppError } from '../errors.ts';
import { getPuzzleStats } from '../profile.ts';
import type { HandlerMap } from './index.ts';

export const lessonHandlers: HandlerMap<'lessons.progress' | 'lessons.update' | 'puzzles.record'> = {
  'lessons.progress': async (_req, { app }) => ({
    lessons: all<{ lesson_id: string; step: number; completed: number; updated_at: string }>(
      app.db,
      'SELECT * FROM lesson_progress ORDER BY lesson_id',
    ).map(toProgress),
  }),

  'lessons.update': async (req, { app }) => {
    if (!/^[a-z0-9-]{2,64}$/.test(String(req.lessonId))) throw new AppError('bad-request', 'Unknown Lesson.');
    const step = Math.max(0, Math.floor(Number(req.step) || 0));
    const previous = one<{ completed: number }>(app.db, 'SELECT completed FROM lesson_progress WHERE lesson_id = ?', req.lessonId);
    // A finished Lesson stays finished if the Player goes through it again.
    const completed = req.completed || previous?.completed === 1 ? 1 : 0;
    app.db
      .prepare(
        `INSERT INTO lesson_progress (lesson_id, step, completed, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(lesson_id) DO UPDATE SET step = excluded.step, completed = excluded.completed, updated_at = excluded.updated_at`,
      )
      .run(req.lessonId, step, completed, iso(app.clock));
    return toProgress(
      one<{ lesson_id: string; step: number; completed: number; updated_at: string }>(
        app.db,
        'SELECT * FROM lesson_progress WHERE lesson_id = ?',
        req.lessonId,
      ) as { lesson_id: string; step: number; completed: number; updated_at: string },
    );
  },

  'puzzles.record': async (req, { app }) => {
    if (!/^[A-Za-z0-9]{3,12}$/.test(String(req.puzzleId))) throw new AppError('bad-request', 'Unknown Puzzle.');
    // Only a Puzzle's first attempt counts: one tried again, from the missed list or on another device, is not stored.
    app.db
      .prepare(
        `INSERT INTO puzzle_attempts (puzzle_id, opening, solved, mistakes, attempted_at)
         SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM puzzle_attempts WHERE puzzle_id = ?)`,
      )
      .run(req.puzzleId, String(req.opening).slice(0, 64), req.solved ? 1 : 0, Math.max(0, Number(req.mistakes) || 0), iso(app.clock), req.puzzleId);
    return getPuzzleStats(app.db);
  },
};

function toProgress(r: { lesson_id: string; step: number; completed: number; updated_at: string }): LessonProgress {
  return { lessonId: r.lesson_id, step: r.step, completed: r.completed === 1, updatedAt: r.updated_at };
}
