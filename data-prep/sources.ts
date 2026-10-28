// Reads the Lesson sources, data/lesson-sources/<id>.json: one file per Lesson, so Lessons can be
// written and checked one at a time (ADR 0011).
import { readdirSync, readFileSync } from 'node:fs';
import type { Side } from '@chess-coach/shared/chess';
import type { CourseLevel, LessonKind, PlayOut, Track } from '@chess-coach/shared/content/lessons';

/** One Lesson's source file. */
export interface Source {
  id: string;
  name: string;
  kind: LessonKind;
  track: Track;
  level: CourseLevel;
  /** The side the Player plays: an opening's colour, otherwise the first part's. */
  side: Side;
  eco?: string;
  /** Lichess puzzle OpeningTags families (openings) and Lichess puzzle themes (Themes, endgames). */
  puzzleTags?: string[];
  puzzleThemes?: string[];
  /** One or two plain sentences: what the Player can do afterwards. */
  goal: string;
  /** Ids of the Lessons to know first. */
  priorKnowledge: string[];
  intro: string;
  /** The Wikibooks or Wikipedia page the intro is kept from, if it is. */
  introUrl?: string;
  playOut?: PlayOut;
  parts: {
    title: string;
    /** FEN, or `start` for the starting position. */
    fen: string;
    side: Side;
    /** One line: the point of this part. */
    keyIdea: string;
    text?: string;
    /** The Wikibooks or Wikipedia page `text` is kept from, if it is. */
    textUrl?: string;
    /** Where the position and the line come from: a Lichess puzzle or game, Lichess's chess-openings, or a Wikibooks or Wikipedia page. */
    url: string;
    /** The line in SAN, both sides' moves, from `fen`. */
    line: string;
    /** Notes on the Player's moves. `url` names the Wikibooks or Wikipedia page a kept note comes from. */
    notes?: { ply: number; san: string; text: string; url?: string }[];
  }[];
}

/** Every Lesson source, by id. */
export function readSources(): Map<string, Source> {
  const dir = new URL('../data/lesson-sources/', import.meta.url);
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Source] as const),
  );
}
