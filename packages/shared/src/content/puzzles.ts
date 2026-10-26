// Bundled Puzzles: a subset of the CC0 Lichess puzzle database, filtered to the Lesson
// catalogue's openings and Themes and to beginner-to-club ratings (ADR 0005, ADR 0008).
import { playUci } from '../chess.ts';
import type { PlayerLevel } from '../protocol.ts';

export interface PuzzleData {
  id: string;
  /** Position before the opponent's move that sets up the Puzzle. */
  fen: string;
  /** UCI moves: the opponent's set-up move, then alternately the Player's answer and the opponent's reply. */
  moves: string[];
  rating: number;
  themes: string[];
  /** Lesson id this Puzzle belongs to. */
  lessonId: string;
  openingTags: string[];
  gameUrl: string;
}

export interface PuzzleFile {
  source: string;
  licence: string;
  puzzles: PuzzleData[];
}

export const LEVEL_PUZZLE_RATING: Record<PlayerLevel, number> = { beginner: 900, casual: 1300, club: 1700 };

/** Puzzles nearest the Player's level first, skipping ones already done. */
export function pickPuzzles(
  puzzles: readonly PuzzleData[],
  target: number,
  options: { lessonId?: string; exclude?: ReadonlySet<string>; count?: number } = {},
): PuzzleData[] {
  return puzzles
    .filter((p) => (!options.lessonId || p.lessonId === options.lessonId) && !options.exclude?.has(p.id))
    .sort((a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target) || a.id.localeCompare(b.id))
    .slice(0, options.count ?? 10);
}

/** What a Lesson's Puzzles must match: one of its opening tags, or one of its Lichess themes. */
export interface PuzzleMatch {
  tags: readonly string[];
  themes: readonly string[];
}

/** The Puzzle data check: every move legal, every Puzzle matching its Lesson's openings or themes. */
export function validatePuzzles(file: PuzzleFile, catalogue: Record<string, PuzzleMatch>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of file.puzzles) {
    if (seen.has(p.id)) problems.push(`Puzzle ${p.id} appears twice`);
    seen.add(p.id);
    const match = catalogue[p.lessonId];
    if (!match) {
      problems.push(`Puzzle ${p.id}: Lesson ${p.lessonId} is not in the catalogue`);
      continue;
    }
    if (!p.openingTags.some((t) => tagMatches(t, match.tags)) && !p.themes.some((t) => match.themes.includes(t))) {
      problems.push(`Puzzle ${p.id}: none of its opening tags (${p.openingTags.join(', ')}) or themes belongs to ${p.lessonId}`);
    }
    if (p.moves.length < 2) problems.push(`Puzzle ${p.id}: needs a set-up move and at least one answer`);
    let fen = p.fen;
    for (const [i, uci] of p.moves.entries()) {
      const played = playUci(fen, uci);
      if (!played) {
        problems.push(`Puzzle ${p.id}: move ${i + 1} (${uci}) is not legal`);
        break;
      }
      fen = played.fenAfter;
    }
  }
  return problems;
}

/** A Lichess opening tag belongs to a family when it is the family or one of its variations. */
export function tagMatches(tag: string, families: readonly string[]): boolean {
  return families.some((f) => tag === f || tag.startsWith(`${f}_`));
}
