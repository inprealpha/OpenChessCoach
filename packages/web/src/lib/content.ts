// Lesson and Puzzle data ship inside the web app, so they can be browsed offline (ADR 0003).
import type { LessonData, LessonKind } from '@chess-coach/shared/content/lessons';
import type { PuzzleFile } from '@chess-coach/shared/content/puzzles';
import catalogue from '../../../../data/lessons/index.json';

export interface CatalogueItem {
  id: string;
  name: string;
  kind: LessonKind;
  side: 'white' | 'black';
  eco?: string;
  decisions: number;
  /** Whether the Lesson ends with a position to play out against the Engine. */
  playOut?: boolean;
}

export const lessonCatalogue = catalogue as CatalogueItem[];

const lessonFiles = import.meta.glob<{ default: LessonData }>(['../../../../data/lessons/*.json', '!../../../../data/lessons/index.json']);

export async function loadLesson(id: string): Promise<LessonData | undefined> {
  const loader = lessonFiles[`../../../../data/lessons/${id}.json`];
  if (!loader || id === 'index') return undefined;
  return (await loader()).default;
}

/** The opening Puzzles and the Theme and endgame Puzzles together. */
export async function loadPuzzles(): Promise<PuzzleFile> {
  const [openings, themes] = await Promise.all([import('../../../../data/puzzles.json'), import('../../../../data/theme-puzzles.json')]);
  const a = openings.default as PuzzleFile;
  const b = themes.default as PuzzleFile;
  return { source: a.source, licence: a.licence, puzzles: [...a.puzzles, ...b.puzzles] };
}
