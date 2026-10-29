// The Player Profile: structured facts the app records itself at no Claude cost, plus at most
// a few terse Coach notes with a hard cap (ADR 0004).
import { MOVE_GRADES, type MoveGrade } from '@chess-coach/shared/grader';
import { PLAYER_LEVELS, type GradeCounts, type PlayerProfile, type PuzzleStats, type RatingSite } from '@chess-coach/shared/protocol';
import { type Clock, iso } from './clock.ts';
import { all, one, transaction, type Db } from './db.ts';
import { AppError } from './errors.ts';

export const NOTE_CAP = 12;
export const NOTE_MAX_LENGTH = 140;
export const MAX_GOALS = 5;
const MIN_MOVES_FOR_PATTERN = 10;

interface ProfileRow {
  onboarded: number;
  level: string;
  rating: number | null;
  rating_site: string | null;
  rating_username: string | null;
  goals: string;
}

export function getProfile(db: Db): PlayerProfile {
  const row = one<ProfileRow>(db, 'SELECT * FROM profile WHERE id = 1') as ProfileRow;
  const gradeCounts = getGradeCounts(db);
  const { strengths, weaknesses } = patterns(gradeCounts);
  return {
    onboarded: row.onboarded === 1,
    level: (PLAYER_LEVELS as readonly string[]).includes(row.level) ? (row.level as PlayerProfile['level']) : 'beginner',
    rating: row.rating,
    ratingSource: row.rating_site && row.rating_username ? { site: row.rating_site as RatingSite, username: row.rating_username } : null,
    goals: JSON.parse(row.goals) as string[],
    strengths,
    weaknesses,
    lessons: all<{ lesson_id: string; step: number; completed: number; updated_at: string }>(
      db,
      'SELECT * FROM lesson_progress ORDER BY updated_at',
    ).map((r) => ({ lessonId: r.lesson_id, step: r.step, completed: r.completed === 1, updatedAt: r.updated_at })),
    puzzles: getPuzzleStats(db),
    gradeCounts,
    notes: all<{ id: number; text: string; created_at: string }>(db, 'SELECT * FROM coach_notes ORDER BY id').map((n) => ({
      id: n.id,
      text: n.text,
      createdAt: n.created_at,
    })),
  };
}

/** Puzzles tried and solved first time, each Puzzle counted once by its first attempt. */
export function getPuzzleStats(db: Db): PuzzleStats {
  const stats = one<{ attempted: number; solved: number }>(
    db,
    `SELECT COUNT(*) AS attempted, COALESCE(SUM(solved), 0) AS solved FROM puzzle_attempts
     WHERE id IN (SELECT MIN(id) FROM puzzle_attempts GROUP BY puzzle_id)`,
  ) ?? { attempted: 0, solved: 0 };
  return { attempted: Number(stats.attempted), solved: Number(stats.solved) };
}

export interface ProfilePatch {
  level?: string;
  goals?: string[];
  onboarded?: boolean;
  /** `pool` and `blitz` are for Maia-3 (ADR 0011): the Player Profile shows only `rating`. */
  rating?: { site: RatingSite; username: string; rating: number; pool?: string; blitz?: number } | null;
}

export function updateProfile(db: Db, patch: ProfilePatch): PlayerProfile {
  if (patch.level !== undefined) {
    if (!(PLAYER_LEVELS as readonly string[]).includes(patch.level)) throw new AppError('bad-request', 'Pick Beginner, Casual or Club.');
    db.prepare('UPDATE profile SET level = ? WHERE id = 1').run(patch.level);
  }
  if (patch.goals !== undefined) {
    const goals = patch.goals.map((g) => g.replace(/\s+/g, ' ').trim()).filter(Boolean).map((g) => g.slice(0, 100));
    if (goals.length > MAX_GOALS) throw new AppError('bad-request', `Keep it to ${MAX_GOALS} Goals or fewer.`);
    db.prepare('UPDATE profile SET goals = ? WHERE id = 1').run(JSON.stringify([...new Set(goals)]));
  }
  if (patch.onboarded !== undefined) db.prepare('UPDATE profile SET onboarded = ? WHERE id = 1').run(patch.onboarded ? 1 : 0);
  if (patch.rating !== undefined) {
    const r = patch.rating;
    db.prepare('UPDATE profile SET rating = ?, rating_site = ?, rating_username = ? WHERE id = 1').run(
      r?.rating ?? null,
      r?.site ?? null,
      r?.username ?? null,
    );
    db.prepare('INSERT INTO rating_pools (id, pool, blitz) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pool = excluded.pool, blitz = excluded.blitz').run(
      r?.pool ?? null,
      r?.blitz ?? null,
    );
  }
  return getProfile(db);
}

/** Whether a Coach note would be new: no equivalent one is saved yet. */
export function isNewNote(db: Db, text: string): boolean {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_LENGTH);
  if (!line) return false;
  const key = noteKey(line);
  return !all<{ text: string }>(db, 'SELECT text FROM coach_notes').some((n) => noteKey(n.text) === key);
}

/**
 * Saves a terse Coach note unless an equivalent one is already there. When the cap is
 * reached, the oldest notes are dropped first. Returns the saved text, or null.
 */
export function addCoachNote(db: Db, clock: Clock, text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_LENGTH);
  if (!isNewNote(db, line)) return null;
  transaction(db, () => {
    db.prepare('INSERT INTO coach_notes (text, created_at) VALUES (?, ?)').run(line, iso(clock));
    db.prepare(
      'DELETE FROM coach_notes WHERE id NOT IN (SELECT id FROM coach_notes ORDER BY id DESC LIMIT ?)',
    ).run(NOTE_CAP);
  });
  return line;
}

export function deleteCoachNote(db: Db, noteId: number): PlayerProfile {
  db.prepare('DELETE FROM coach_notes WHERE id = ?').run(noteId);
  return getProfile(db);
}

function noteKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function addGradeCounts(db: Db, opening: string, grades: readonly MoveGrade[]): void {
  const put = db.prepare(
    'INSERT INTO grade_counts (opening, grade, count) VALUES (?, ?, 1) ON CONFLICT(opening, grade) DO UPDATE SET count = count + 1',
  );
  transaction(db, () => {
    for (const g of grades) put.run(opening, g);
  });
}

/**
 * Takes back Move Grades counted by `addGradeCounts`, such as those of a Review that no longer
 * applies. Run it inside the transaction that drops that Review.
 */
export function removeGradeCounts(db: Db, opening: string, grades: readonly MoveGrade[]): void {
  const take = db.prepare('UPDATE grade_counts SET count = count - 1 WHERE opening = ? AND grade = ?');
  for (const g of grades) take.run(opening, g);
  db.prepare('DELETE FROM grade_counts WHERE opening = ? AND count <= 0').run(opening);
}

function getGradeCounts(db: Db): Record<string, GradeCounts> {
  const out: Record<string, GradeCounts> = {};
  for (const r of all<{ opening: string; grade: MoveGrade; count: number }>(db, 'SELECT * FROM grade_counts')) {
    (out[r.opening] ??= {})[r.grade] = r.count;
  }
  return out;
}

/** Strengths and weaknesses derived from Move Grade counts, with no Coach call. */
export function patterns(counts: Record<string, GradeCounts>): { strengths: string[]; weaknesses: string[] } {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  for (const [opening, c] of Object.entries(counts)) {
    const total = MOVE_GRADES.reduce((n, g) => n + (c[g] ?? 0), 0);
    if (total < MIN_MOVES_FOR_PATTERN) continue;
    const bad = (c.Mistake ?? 0) + (c.Blunder ?? 0);
    const good = (c.Best ?? 0) + (c.Good ?? 0);
    if (bad / total >= 0.15) weaknesses.push(`${opening}: ${bad} of ${total} moves were Mistakes or Blunders`);
    else if (good / total >= 0.85) strengths.push(`${opening}: ${good} of ${total} moves graded Best or Good`);
  }
  return { strengths, weaknesses };
}
