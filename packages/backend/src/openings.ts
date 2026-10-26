import { OpeningBook, type OpeningEntry } from '@chess-coach/shared/openings';
import entries from '../../../data/openings.json' with { type: 'json' };

let book: OpeningBook | undefined;

export function openingName(moves: readonly string[], startFen?: string, fallback?: string): string {
  book ??= new OpeningBook(entries as OpeningEntry[]);
  return book.name(moves, startFen)?.name ?? fallback ?? 'Unknown opening';
}
