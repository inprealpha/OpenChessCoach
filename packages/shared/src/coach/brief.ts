// Builds the compact, fresh brief every Coach call starts from (ADR 0004).
import type { Candidate } from '../analysis.ts';
import { playUci, turnOf, type Side } from '../chess.ts';
import { formatScore, gradeMove, type MoveGrade } from '../grader.ts';
import type { CoachJob, PlayerLevel, PlayerProfile } from '../protocol.ts';
import type { CoachAsk } from './types.ts';

/** Hard ceiling on the serialised brief, in characters. */
export const BRIEF_BUDGET = 3500;

export const MAX_WORDS: Record<CoachJob, number> = {
  'review-moment': 110,
  why: 150,
  'lesson-turn': 130,
  hint: 40,
  live: 40,
};

const MAX_CANDIDATES = 5;
const MAX_REPLIES = 3;
const LINE_PLIES = 5;
const RECENT_PLIES = 16;
const MAX_QUESTION = 400;
const MAX_SUMMARY = 600;
const MAX_NOTES = 700;
const MAX_PROFILE_ITEMS = 3;

export interface BriefCandidate {
  san: string;
  uci: string;
  /** Engine evaluation from the side to move, e.g. "+0.45" or "M3". */
  eval: string;
  /** How the Engine grades this candidate compared with its best move. */
  grade: MoveGrade;
  /** The Engine's line after it, in SAN. */
  line: string;
}

/**
 * Everything the Coach sees. Every chess judgement in it comes from the Engine:
 * there is deliberately no field for the Coach's own evaluation (ADR 0002).
 */
export interface Brief {
  job: CoachJob;
  level: PlayerLevel;
  rating?: number;
  playerSide?: Side;
  sideToMove: Side;
  fen: string;
  recentMoves: string;
  move?: { san: string; uci: string; grade: MoveGrade; evalAfter: string };
  candidates: BriefCandidate[];
  replies?: BriefCandidate[];
  lesson?: { opening: string; notes: string; popularity: string };
  profile?: { goals: string[]; weaknesses: string[]; notes: string[] };
  question?: string;
  summary?: string;
  maxWords: number;
  /** Whether the reply may carry one new terse Player Profile note. */
  allowNote: boolean;
  /** Hints: explain the idea without naming or showing any move. */
  hideMoves: boolean;
}

export function briefSize(brief: Brief): number {
  return JSON.stringify(brief).length;
}

export class BriefTooLargeError extends Error {
  readonly size: number;
  constructor(size: number) {
    super(`Coach brief is ${size} characters, over the ${BRIEF_BUDGET}-character budget (ADR 0004)`);
    this.size = size;
  }
}

/** The ADR 0004 check: throws when a brief is over budget. The backend runs it before every Coach call. */
export function assertBriefWithinBudget(brief: Brief): void {
  const size = briefSize(brief);
  if (size > BRIEF_BUDGET) throw new BriefTooLargeError(size);
}

export interface BriefInput {
  ask: CoachAsk;
  profile: Pick<PlayerProfile, 'level' | 'rating' | 'goals' | 'weaknesses' | 'notes'>;
  summary?: string;
}

export function buildBrief({ ask, profile, summary }: BriefInput): Brief {
  const hideMoves = ask.job === 'hint';
  const candidates = briefCandidates(ask.fen, ask.candidates, MAX_CANDIDATES);
  const brief: Brief = {
    job: ask.job,
    level: profile.level,
    ...(profile.rating ? { rating: profile.rating } : {}),
    ...(ask.playerSide ? { playerSide: ask.playerSide } : {}),
    sideToMove: turnOf(ask.fen),
    fen: ask.fen,
    recentMoves: formatRecent(ask.recentMoves, ask.fen),
    candidates,
    maxWords: MAX_WORDS[ask.job],
    allowNote: Boolean(ask.allowNote || ask.lesson?.finalTurn),
    hideMoves,
  };
  if (ask.move) {
    const played = playUci(ask.fen, ask.move.uci);
    if (played) {
      brief.move = {
        san: played.san,
        uci: played.uci,
        grade: ask.move.grade,
        evalAfter: formatScore(ask.move.playedScore),
      };
      if (ask.replies?.length) brief.replies = briefCandidates(played.fenAfter, ask.replies, MAX_REPLIES);
    }
  }
  if (ask.lesson) {
    brief.lesson = {
      opening: clip(ask.lesson.opening, 80),
      notes: clip(ask.lesson.notes, MAX_NOTES),
      popularity: ask.lesson.popularity
        .slice(0, 5)
        .map((p) => `${p.san} ${Math.round(p.percent)}%`)
        .join(', '),
    };
  }
  const slice = profileSlice(profile, ask.opening ?? ask.lesson?.opening);
  if (slice) brief.profile = slice;
  if (ask.question?.trim()) brief.question = clip(ask.question.trim(), MAX_QUESTION);
  if (summary?.trim()) brief.summary = clip(summary.trim(), MAX_SUMMARY);
  return fitToBudget(brief);
}

function briefCandidates(fen: string, candidates: readonly Candidate[], max: number): BriefCandidate[] {
  const best = candidates[0];
  const out: BriefCandidate[] = [];
  for (const c of candidates.slice(0, max)) {
    const played = playUci(fen, c.uci);
    if (!played || !best) continue;
    const line = linesSan(played.fenAfter, c.pv.slice(1, LINE_PLIES));
    out.push({
      san: played.san,
      uci: played.uci,
      eval: formatScore(c.score),
      grade: gradeMove({ best: best.score, played: c.score, isTopMove: c.uci === best.uci }).grade,
      line,
    });
  }
  return out;
}

function linesSan(fen: string, ucis: readonly string[]): string {
  const sans: string[] = [];
  let current = fen;
  for (const uci of ucis) {
    const played = playUci(current, uci);
    if (!played) break;
    sans.push(played.san);
    current = played.fenAfter;
  }
  return sans.join(' ');
}

function formatRecent(moves: readonly string[], fen: string): string {
  const recent = moves.slice(-RECENT_PLIES).map((m) => clip(m, 8));
  const fullmove = Number(fen.split(' ')[5] ?? '1');
  const blackToMove = turnOf(fen) === 'black';
  // Number the moves backwards from the current position.
  let ply = (fullmove - 1) * 2 + (blackToMove ? 1 : 0) - recent.length;
  const parts: string[] = [];
  for (const san of recent) {
    const moveNo = Math.floor(ply / 2) + 1;
    if (ply % 2 === 0) parts.push(`${moveNo}. ${san}`);
    else parts.push(parts.length === 0 ? `${moveNo}... ${san}` : san);
    ply++;
  }
  return parts.join(' ');
}

/** The parts of the Player Profile that match this opening or theme, and nothing else (ADR 0004). */
export function profileSlice(
  profile: Pick<PlayerProfile, 'goals' | 'weaknesses' | 'notes'>,
  topic: string | undefined,
): Brief['profile'] | undefined {
  if (!topic) return undefined;
  const words = keywords(topic);
  const matches = (text: string) => keywords(text).some((w) => words.includes(w));
  const goals = profile.goals.filter(matches).slice(0, MAX_PROFILE_ITEMS).map((g) => clip(g, 100));
  const weaknesses = profile.weaknesses.filter(matches).slice(0, MAX_PROFILE_ITEMS).map((w) => clip(w, 100));
  const notes = profile.notes
    .map((n) => n.text)
    .filter(matches)
    .slice(-MAX_PROFILE_ITEMS)
    .map((n) => clip(n, 140));
  if (!goals.length && !weaknesses.length && !notes.length) return undefined;
  return { goals, weaknesses, notes };
}

const STOP_WORDS = new Set(['the', 'game', 'defence', 'defense', 'opening', 'system', 'variation', 'learn', 'with', 'and', 'for', 'play', 'better', 'get', 'my', 'a', 'an', 'of', 'to', 'in']);

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Trims the least important parts until the brief fits. */
function fitToBudget(brief: Brief): Brief {
  const steps: ((b: Brief) => void)[] = [
    (b) => { if (b.summary) b.summary = clip(b.summary, 250); },
    (b) => { if (b.lesson) b.lesson.notes = clip(b.lesson.notes, 300); },
    (b) => { if (b.profile) b.profile.notes = b.profile.notes.slice(-1); },
    (b) => { b.candidates.forEach((c) => (c.line = c.line.split(' ').slice(0, 2).join(' '))); },
    (b) => { if (b.replies) b.replies = b.replies.slice(0, 2); },
    (b) => { b.recentMoves = b.recentMoves.split(' ').slice(-12).join(' '); },
    (b) => { if (b.question) b.question = clip(b.question, 200); },
    (b) => { delete b.profile; },
    (b) => { delete b.summary; },
  ];
  for (const step of steps) {
    if (briefSize(brief) <= BRIEF_BUDGET) break;
    step(brief);
  }
  assertBriefWithinBudget(brief);
  return brief;
}
