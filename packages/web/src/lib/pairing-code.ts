/** The pairing code, from the pairing link, in groups of four for reading out and typing (the Pair screen ignores the spaces). */
export function pairingCode(pairUrl: string): string {
  return (/#pair=(.+)$/.exec(pairUrl)?.[1] ?? '').replace(/(.{4})(?!$)/g, '$1 ');
}
