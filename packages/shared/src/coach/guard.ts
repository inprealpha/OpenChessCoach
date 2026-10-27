// The Coach move guard (ADR 0002): before a Coach reply reaches any client, every move and
// arrow is checked against the Engine's candidates in that call's brief. Anything else is stripped.
import { playSan, playUci } from '../chess.ts';
import { threatFen, type Brief } from './brief.ts';
import type { Arrow, CoachRawReply } from './types.ts';

const SQUARE = /^[a-h][1-8]$/;
const MAX_ARROWS = 4;
const MAX_HIGHLIGHTS = 4;
const MAX_NOTE = 140;

export interface GuardResult {
  moves: string[];
  arrows: Arrow[];
  highlights: string[];
  note: string | null;
  /** Human-readable reasons for everything removed. */
  stripped: string[];
}

/** The moves the Engine produced for this brief, each legal in the position it belongs to. */
export function allowedMoves(brief: Brief): Set<string> {
  const allowed = new Set<string>();
  for (const c of brief.candidates) if (playUci(brief.fen, c.uci)) allowed.add(c.uci);
  // The opponent's threat, legal where it would be played: after the move, or in `fen` after a pass.
  const from = brief.threat ? threatFen(brief) : undefined;
  if (brief.threat && from && playUci(from, brief.threat.uci)) allowed.add(brief.threat.uci);
  if (brief.move) {
    const played = playUci(brief.fen, brief.move.uci);
    if (played) {
      allowed.add(played.uci);
      for (const r of brief.replies ?? []) if (playUci(played.fenAfter, r.uci)) allowed.add(r.uci);
    }
  }
  return allowed;
}

/**
 * The moves of the Engine's line after a move the Player asked about, each legal where the line
 * plays it. The Coach may name them, but never draw them: the board shows the position before the
 * line, where they aren't played.
 */
export function askedLineMoves(brief: Brief): Set<string> {
  const out = new Set<string>();
  for (const c of brief.candidates.filter((x) => x.asked)) {
    let played = playUci(brief.fen, c.uci);
    for (const san of c.line.split(' ').filter(Boolean)) {
      played = played && playSan(played.fenAfter, san);
      if (!played) break;
      out.add(played.uci);
    }
  }
  return out;
}

export function guardReply(brief: Brief, raw: CoachRawReply): GuardResult {
  const allowed = brief.hideMoves ? new Set<string>() : allowedMoves(brief);
  const named = brief.hideMoves ? new Set<string>() : askedLineMoves(brief);
  const stripped: string[] = [];

  const moves: string[] = [];
  for (const uci of raw.moves) {
    if (allowed.has(uci) || named.has(uci)) {
      if (!moves.includes(uci)) moves.push(uci);
    } else stripped.push(`move ${uci} is not in the Engine's output`);
  }

  const arrows: Arrow[] = [];
  for (const a of raw.arrows) {
    if (!allowed.has(a.uci)) {
      stripped.push(`arrow ${a.uci} is not in the Engine's output`);
      continue;
    }
    if (arrows.length >= MAX_ARROWS) continue;
    arrows.push({ from: a.uci.slice(0, 2), to: a.uci.slice(2, 4), brush: a.brush });
  }

  const highlights = brief.hideMoves
    ? []
    : [...new Set(raw.highlights.filter((s) => SQUARE.test(s)))].slice(0, MAX_HIGHLIGHTS);

  let note: string | null = null;
  if (raw.note && brief.allowNote) {
    const line = raw.note.replace(/\s+/g, ' ').trim();
    if (line) note = line.length > MAX_NOTE ? `${line.slice(0, MAX_NOTE - 1)}…` : line;
  }
  return { moves, arrows, highlights, note, stripped };
}
