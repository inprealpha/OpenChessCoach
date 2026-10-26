// How the app counts Move Grades in its text, such as the Lesson's summary of first tries.
import { describe, expect, it } from 'vitest';
import { gradeCount } from '../src/lib/grades.ts';

describe('a count of a Move Grade', () => {
  it('is singular for one and plural for several', () => {
    expect(gradeCount(1, 'Inaccuracy')).toBe('1 Inaccuracy');
    expect(gradeCount(2, 'Inaccuracy')).toBe('2 Inaccuracies');
    expect(gradeCount(1, 'Mistake')).toBe('1 Mistake');
    expect(gradeCount(2, 'Mistake')).toBe('2 Mistakes');
    expect(gradeCount(3, 'Blunder')).toBe('3 Blunders');
  });

  it('keeps Best and Good as they are', () => {
    expect(gradeCount(5, 'Best')).toBe('5 Best');
    expect(gradeCount(2, 'Good')).toBe('2 Good');
  });
});
