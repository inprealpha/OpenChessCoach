// Which Lesson the app suggests next (ADR 0011): nothing is locked, the suggestion only orders what
// to do first. Each rule of suggestNext, on a small made-up catalogue in course order.
import { describe, expect, it } from 'vitest';
import { suggestNext, type CatalogueItem } from '../src/content/course.ts';
import type { LessonProgress, PlayerLevel } from '../src/protocol.ts';

/** A catalogue entry with only what the suggestion reads set. */
function lesson(id: string, level: CatalogueItem['level'], priorKnowledge: string[] = []): CatalogueItem {
  return { id, name: id, kind: 'theme', track: 'themes', level, side: 'white', goal: '', priorKnowledge, decisions: 5 };
}

/**
 * In course order: two beginner Lessons, the second building on the first; a beginner Lesson that
 * builds on a later one; then two intermediate Lessons, one building on a beginner Lesson and one
 * on the other intermediate Lesson.
 */
const CATALOGUE = [
  lesson('forks', 'beginner'),
  lesson('pins', 'beginner', ['forks']),
  lesson('skewers', 'beginner', ['mate']),
  lesson('mate', 'beginner'),
  lesson('double-attack', 'intermediate', ['forks']),
  lesson('overloading', 'intermediate', ['double-attack']),
];

const done = (lessonId: string, updatedAt = '2026-10-01T10:00:00.000Z'): LessonProgress => ({ lessonId, step: 5, completed: true, updatedAt });
const started = (lessonId: string, step: number, updatedAt = '2026-10-01T10:00:00.000Z'): LessonProgress => ({ lessonId, step, completed: false, updatedAt });
const suggest = (progress: LessonProgress[], level: PlayerLevel = 'beginner') => {
  const s = suggestNext(CATALOGUE, progress, level);
  return s && { id: s.lesson.id, why: s.why };
};

describe('suggestNext', () => {
  it('starts a new beginner at the first Lesson in the course order', () => {
    expect(suggest([])).toEqual({ id: 'forks', why: 'first' });
  });

  it('suggests nothing once every Lesson is finished, at any level', () => {
    const all = CATALOGUE.map((l) => done(l.id));
    for (const level of ['beginner', 'casual', 'club'] as const) expect(suggest(all, level)).toBeUndefined();
  });

  it('suggests the Lesson the Player started and has not finished, before any other', () => {
    expect(suggest([done('forks'), started('mate', 2)])).toEqual({ id: 'mate', why: 'unfinished' });
    // Even one below the Player's level: they chose to start it.
    expect(suggest([started('pins', 1)], 'club')).toEqual({ id: 'pins', why: 'unfinished' });
  });

  it('of two unfinished Lessons, suggests the one worked on most recently', () => {
    const progress = [started('forks', 1, '2026-10-02T09:00:00.000Z'), started('mate', 3, '2026-10-01T09:00:00.000Z')];
    expect(suggest(progress)).toEqual({ id: 'forks', why: 'unfinished' });
    progress[1] = started('mate', 3, '2026-10-03T09:00:00.000Z');
    expect(suggest(progress)).toEqual({ id: 'mate', why: 'unfinished' });
  });

  it('does not count a Lesson opened with no decision played, or one no longer in the catalogue, as unfinished', () => {
    expect(suggest([started('mate', 0)])).toEqual({ id: 'forks', why: 'first' });
    expect(suggest([started('gone', 4)])).toEqual({ id: 'forks', why: 'first' });
    // A finished Lesson gone from the catalogue counts for nothing either: the Player has finished none of these.
    expect(suggest([done('gone')])).toEqual({ id: 'forks', why: 'first' });
  });

  it('says a Lesson is ready once the Player has finished every Lesson it builds on', () => {
    expect(suggest([done('forks')])).toEqual({ id: 'pins', why: 'ready' });
  });

  it('skips a Lesson whose prior knowledge is not finished, and comes back to it once it is', () => {
    // Skewers builds on Mate, which comes later in the course order and builds on nothing: next in order.
    const progress = [done('forks'), done('pins')];
    expect(suggest(progress)).toEqual({ id: 'mate', why: 'next' });
    progress.push(done('mate'));
    expect(suggest(progress)).toEqual({ id: 'skewers', why: 'ready' });
  });

  it('starts a casual or club Player at the first intermediate Lesson, with the beginner Lessons it builds on counted as known', () => {
    for (const level of ['casual', 'club'] as const) {
      expect(suggest([], level)).toEqual({ id: 'double-attack', why: 'first' });
      expect(suggest([done('double-attack')], level)).toEqual({ id: 'overloading', why: 'ready' });
    }
  });

  it('does not call a Lesson ready when some of what it builds on is only known from the Player’s level', () => {
    // A casual Player who has done a beginner Lesson by choice: Double attack builds on Forks, which they have not done.
    expect(suggest([done('mate')], 'casual')).toEqual({ id: 'double-attack', why: 'next' });
  });

  it('once a casual Player has finished the intermediate Lessons, suggests the beginner ones they skipped', () => {
    expect(suggest([done('double-attack'), done('overloading')], 'casual')).toEqual({ id: 'forks', why: 'next' });
  });

  it('when no Lesson has its prior knowledge finished, still suggests the first one not finished', () => {
    // Prior knowledge going round in a circle: the data check refuses it, and the suggestion still offers a Lesson.
    const circle = [lesson('a', 'beginner', ['b']), lesson('b', 'beginner', ['a'])];
    expect(suggestNext(circle, [], 'beginner')).toMatchObject({ lesson: { id: 'a' }, why: 'first' });
  });

  it('treats prior knowledge that names no Lesson in the catalogue as known', () => {
    const catalogue = [lesson('a', 'beginner'), lesson('b', 'beginner', ['removed']), lesson('c', 'beginner')];
    expect(suggestNext(catalogue, [done('a')], 'beginner')).toMatchObject({ lesson: { id: 'b' }, why: 'next' });
  });

  it('suggests nothing from an empty catalogue', () => {
    expect(suggestNext([], [started('forks', 2)], 'beginner')).toBeUndefined();
  });
});
