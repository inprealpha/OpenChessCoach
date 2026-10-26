// The set of Puzzles the Player just chose. Each set is its own address, and a new address is a
// new Puzzles screen, so the new screen asks whether the Player chose it, to put focus back on
// the choice they just used.
let chosen: string | undefined;

/** The Player follows the link to `set` ('' for every Lesson mixed). */
export function markChosen(set: string): void {
  chosen = set;
}

/** Whether the Player got to `set` by choosing it. Asked once, by the set's new screen. */
export function arrivedByChoosing(set: string): boolean {
  const yes = chosen === set;
  chosen = undefined;
  return yes;
}
