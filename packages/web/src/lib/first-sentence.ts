// A text's first sentence, the one-line summary a folded section shows (docs/design/interface-guidelines.md).

/** A move written after its number: "12. Bg5", "12… Nf6" reads as "12." then a move. */
const MOVE_AFTER_NUMBER = /^\s*(?:…|\.\.\.)?\s*(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]|O-O)/;

/**
 * The text up to the end of its first sentence. A move number ("12." before "Bg5") ends no
 * sentence; any other number does ("…and no Blunder 0. Then", "won 1-0. Your").
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  const end = /[.!?](?=\s|$)/g;
  for (let m = end.exec(t); m; m = end.exec(t)) {
    const moveNumber = m[0] === '.' && /\b\d+$/.test(t.slice(0, m.index)) && MOVE_AFTER_NUMBER.test(t.slice(m.index + 1));
    if (!moveNumber) return t.slice(0, m.index + 1);
  }
  return t;
}
