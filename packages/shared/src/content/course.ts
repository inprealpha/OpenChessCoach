// The course across the four tracks (ADR 0012): the catalogue entry of each Lesson, and which
// Lesson the app suggests next. Nothing is locked; the suggestion only orders what to do first.
import type { Side } from '../chess.ts';
import type { LessonProgress, PlayerLevel, PlayerProfile } from '../protocol.ts';
import { bandFor, type CourseLevel, type LessonKind, type Track } from './lessons.ts';

/** One Lesson in `data/lessons/index.json`, which lists them in the course's suggested order. */
export interface CatalogueItem {
  id: string;
  name: string;
  kind: LessonKind;
  track: Track;
  level: CourseLevel;
  side: Side;
  eco?: string;
  goal: string;
  priorKnowledge: string[];
  decisions: number;
  /** Whether the Lesson ends with a position to play out against the Engine. */
  playOut?: boolean;
}

export const TRACK_NAMES: Record<Track, { name: string; text: string }> = {
  themes: { name: 'Themes', text: 'Patterns that win material, give mate or save a game, such as forks and pins.' },
  endgames: { name: 'Endgames', text: 'Positions with few pieces left, and how to win or save them.' },
  openings: { name: 'Openings', text: 'How to start a game, and openings for White and for Black.' },
  thinking: { name: 'How to think during a game', text: 'What to check before every move, and how to make a plan.' },
};

export const LEVEL_NAMES: Record<CourseLevel, string> = { beginner: 'Beginner', intermediate: 'Intermediate' };

/** Course levels a Player in this band already knows: a casual or club Player skips the beginner Lessons. */
export function knownLevels(band: PlayerLevel): readonly CourseLevel[] {
  return band === 'beginner' ? [] : ['beginner'];
}

export interface Suggestion {
  lesson: CatalogueItem;
  /**
   * Why this Lesson, so the screen can say so in a line:
   * - `unfinished`: the Player started it and has not finished it;
   * - `first`: the Player has finished no Lesson yet, so this is where to start;
   * - `ready`: it builds on other Lessons, and the Player has finished every one of them;
   * - `next`: it is the next Lesson in the course order.
   */
  why: 'unfinished' | 'first' | 'ready' | 'next';
}

/**
 * The Lesson to suggest next:
 * 1. the Lesson the Player most recently worked on without finishing it;
 * 2. otherwise the first Lesson in the course order that is not finished, is not below the Player's
 *    level, and whose prior knowledge is all finished (or below the Player's level);
 * 3. otherwise the first Lesson not finished and not below the Player's level;
 * 4. otherwise the first Lesson not finished. Undefined when every Lesson is finished.
 * The Player's level is their band, as the popularity tables use it (`bandFor`): the level in the
 * Player Profile, or the band of their linked rating, so a casual Player rated under 1400 starts
 * with the beginner Lessons. Prior knowledge that names no Lesson in the catalogue counts as known:
 * nothing is locked, and a Lesson must not drop out of the suggestions because one it built on was
 * taken out.
 */
export function suggestNext(
  catalogue: readonly CatalogueItem[],
  progress: readonly LessonProgress[],
  player: Pick<PlayerProfile, 'level' | 'rating'>,
): Suggestion | undefined {
  const levelOf = new Map(catalogue.map((l) => [l.id, l.level]));
  const finished = new Set(progress.filter((p) => p.completed && levelOf.has(p.lessonId)).map((p) => p.lessonId));
  const unfinished = progress
    .filter((p) => !p.completed && p.step > 0 && levelOf.has(p.lessonId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const started = unfinished && catalogue.find((l) => l.id === unfinished.lessonId);
  if (started) return { lesson: started, why: 'unfinished' };
  const known = knownLevels(bandFor(player.level, player.rating));
  const met = (id: string) => {
    const at = levelOf.get(id);
    return finished.has(id) || at === undefined || known.includes(at);
  };
  const open = catalogue.filter((l) => !finished.has(l.id));
  const atLevel = open.filter((l) => !known.includes(l.level));
  const ready = atLevel.find((l) => l.priorKnowledge.every(met));
  const lesson = ready ?? atLevel[0] ?? open[0];
  if (!lesson) return undefined;
  if (finished.size === 0) return { lesson, why: 'first' };
  const builtOn = lesson.priorKnowledge.filter((id) => levelOf.has(id));
  return { lesson, why: lesson === ready && builtOn.length > 0 && builtOn.every((id) => finished.has(id)) ? 'ready' : 'next' };
}
