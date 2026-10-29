// Builds the compact, fresh brief every Coach call starts from (ADR 0004).
import type { Candidate } from '../analysis.ts';
import { outcomeOf, playUci, turnOf, type Side } from '../chess.ts';
import type { Score } from '../engine.ts';
import { formatScore, gradeMove, type MoveGrade } from '../grader.ts';
import { finishedScore, type PositionScore } from '../position-score.ts';
import type { CoachJob, PlayerLevel, PlayerProfile } from '../protocol.ts';
import { isForcing, nullMoveFen } from '../threat.ts';
import { winningChancesFor } from '../winning-chances.ts';
import { describeFact, describeOutcome, lineOutcome, moveFacts, readLine, worthSaying, type MoveFact } from './explain.ts';
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
/**
 * Longest Lesson learning goal and key idea (ADR 0012). The Lesson data check holds the data to them,
 * and the brief never trims them, so the largest brief still fits its budget (ADR 0004).
 */
export const MAX_LEARNING_GOAL = 240;
export const MAX_KEY_IDEA = 140;
const MAX_LESSON_NAME = 80;
/** Jobs that must stay short: their briefs explain only the move, the Engine's best move and its best reply. */
const CHEAP_JOBS: readonly CoachJob[] = ['live', 'hint'];

export interface BriefCandidate {
  san: string;
  uci: string;
  /** Engine evaluation from the side to move, e.g. "+0.45" or "M3". Not "eval": the Coach reads this key. */
  evaluation: string;
  /** How the Engine grades this candidate compared with its best move. */
  grade: MoveGrade;
  /** The Engine's line after it, in SAN. Empty for a reply on a turn that keeps the Lesson's move back. */
  line: string;
  /** What the move does on the board, read off the board and the Engine's line (see explain.ts). */
  does?: string;
  /** What the forcing moves right after it lead to, for the side that plays it: material or a mate. */
  result?: string;
  /** The Player's question names this move. When the Engine didn't list it, it comes after the candidates. */
  asked?: true;
  /** Many players at the Player's level would reach for this move here (ADR 0011). */
  tempting?: true;
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
  move?: { san: string; uci: string; grade: MoveGrade; evaluationAfter: string; does?: string; result?: string; tempting?: true };
  /** The Player's Winning Chances in `fen` and after the move, worded exactly as the screen shows them. */
  winningChances?: { before: string; after?: string };
  candidates: BriefCandidate[];
  /**
   * The tempting moves the Engine didn't list (ADR 0011): moves many players at the Player's level
   * would reach for in `fen`, each graded and explained against the Engine's best move as the
   * candidates are. The tempting moves among the candidates and the move are marked `tempting`.
   */
  tempting?: BriefCandidate[];
  replies?: BriefCandidate[];
  /**
   * What `by`, the side not to move in `fen`, would play if it were their move: a forcing move the
   * Engine found that would cost the side to move at least an Inaccuracy, with the Engine's
   * line after it. With a move, it is there only when the Engine's best reply to the move is still
   * that threat (`ignored`), and it is played from the position after the move (see `threatFen`).
   */
  threat?: { by: Side; san: string; uci: string; line: string; ignored?: true };
  /**
   * A Lesson turn's context. `isLessonMove: false` marks a move that isn't the one the Lesson
   * teaches, while the Player may try again: the brief then keeps back the Lesson's move and the
   * Engine's best move (no candidates, no notes, only the move's own popularity, and nothing of the
   * Engine's lines past the replies: no line after a reply or the threat, and a result with no
   * moves), so the Coach explains the move played and what it allows without giving the answer away.
   */
  lesson?: { opening: string; notes: string; popularity: string; isLessonMove?: false };
  /**
   * During a Lesson, on every Coach call: the Lesson, its learning goal and the current part's key
   * idea, so the Coach stays on the Lesson's point (ADR 0012). The Lesson's aim, never an Engine fact,
   * and not the Player's Goals (`profile.goals`). A Lesson turn leaves the name out: `lesson.opening`
   * already gives it. A Lesson turn that keeps the answer back leaves the key idea out too: it can
   * all but name the Lesson's move, and a Hint is the place for a nudge.
   */
  focus?: { lesson?: string; learningGoal: string; keyIdea?: string };
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
  const cheap = CHEAP_JOBS.includes(ask.job);
  // A move that isn't the Lesson's, which the Player may try again: like a Hint, the brief keeps
  // the answer back, so it has none of the Engine's moves in the position, only the move and the
  // replies to it. Nor anything of the Engine's lines past the replies: the Lesson's move is often
  // still the Player's best move a move later, and the guard checks moves, not text.
  const keepBack = ask.lesson?.isLessonMove === false;
  // The move's own candidate line can differ from the line after the move: the move's facts come from the latter.
  const candidates = keepBack
    ? []
    : briefCandidates(ask.fen, ask.candidates, MAX_CANDIDATES, (c, i) =>
        c.uci === ask.move?.uci || (cheap && i > 0) ? {} : explained(ask.fen, c.uci, c.pv.slice(1), c.score, { moves: hideMoves }),
      );
  // The moves the Player's question names: marked among the candidates, or added after them,
  // graded against the Engine's best move as the candidates are.
  const asked = keepBack ? [] : (ask.asked ?? []);
  for (const c of candidates) if (asked.some((a) => a.uci === c.uci)) c.asked = true;
  const others = asked.filter((a) => !candidates.some((c) => c.uci === a.uci));
  const extra = briefCandidates(ask.fen, others, others.length, (a) => explained(ask.fen, a.uci, a.pv.slice(1), a.score, { moves: hideMoves }), ask.candidates[0]);
  candidates.push(...extra.map((c) => ({ ...c, asked: true as const })));
  // The tempting moves (ADR 0011): marked among the candidates and on the move, the rest listed
  // apart, graded against the Engine's best move as the candidates are.
  const tempting = keepBack ? [] : (ask.tempting ?? []);
  for (const c of candidates) if (tempting.some((t) => t.uci === c.uci)) c.tempting = true;
  const unlisted = tempting.filter((t) => t.uci !== ask.move?.uci && !candidates.some((c) => c.uci === t.uci));
  const temptingOthers = briefCandidates(ask.fen, unlisted, unlisted.length, (t) => explained(ask.fen, t.uci, t.pv.slice(1), t.score, { moves: hideMoves }), ask.candidates[0]);
  const brief: Brief = {
    job: ask.job,
    level: profile.level,
    ...(profile.rating ? { rating: profile.rating } : {}),
    ...(ask.playerSide ? { playerSide: ask.playerSide } : {}),
    sideToMove: turnOf(ask.fen),
    fen: ask.fen,
    recentMoves: formatRecent(ask.recentMoves, ask.fen),
    candidates,
    ...(temptingOthers.length ? { tempting: temptingOthers } : {}),
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
        evaluationAfter: formatScore(ask.move.playedScore),
        ...explained(ask.fen, played.uci, ask.replies?.[0]?.pv ?? [], ask.move.playedScore, keepBack ? { moves: true, mateDetails: true } : { moves: hideMoves }),
        ...(tempting.some((t) => t.uci === played.uci) ? { tempting: true as const } : {}),
      };
      // The replies say what they do; what the line leads to is the move's result.
      if (ask.replies?.length) {
        brief.replies = briefCandidates(played.fenAfter, ask.replies, MAX_REPLIES, (r, i) =>
          cheap && i > 0 ? {} : explained(played.fenAfter, r.uci, r.pv.slice(1), undefined, { nextMove: keepBack }),
        );
        // Kept back, a reply is the opponent's move alone: the line after it is the Player's next moves.
        if (keepBack) for (const r of brief.replies) r.line = '';
      }
    }
  }
  const chances = winningChancesOf(ask);
  if (chances) brief.winningChances = chances;
  const threat = threatOf(ask);
  // Kept back, the threat is the move's best reply and no more, as the replies are.
  if (threat) brief.threat = keepBack ? { ...threat, line: '' } : threat;
  if (ask.lesson) {
    // Kept back, the notes and the other moves' popularity would name the Lesson's move.
    const popular = keepBack ? ask.lesson.popularity.filter((p) => p.san === brief.move?.san) : ask.lesson.popularity;
    brief.lesson = {
      opening: clip(ask.lesson.opening, MAX_LESSON_NAME),
      notes: keepBack ? '' : clip(ask.lesson.notes, MAX_NOTES),
      popularity: popular
        .slice(0, 5)
        // A move in SAN is at most 7 characters (exd8=Q+); a longer name from the client is clipped.
        .map((p) => `${clip(p.san, 8)} ${Math.round(p.percent)}%`)
        .join(', '),
      ...(keepBack ? { isLessonMove: false as const } : {}),
    };
  }
  const focus = ask.lessonFocus;
  // Kept back, the key idea goes too: it is often one step from the Lesson's move.
  const keyIdea = keepBack ? '' : (focus?.keyIdea.trim() ?? '');
  if (focus && (focus.learningGoal.trim() || keyIdea)) {
    const name = clip(focus.lesson.trim(), MAX_LESSON_NAME);
    brief.focus = {
      ...(brief.lesson?.opening === name ? {} : { lesson: name }),
      learningGoal: clip(focus.learningGoal.trim(), MAX_LEARNING_GOAL),
      ...(keepBack ? {} : { keyIdea: clip(keyIdea, MAX_KEY_IDEA) }),
    };
  }
  const slice = profileSlice(profile, ask.opening ?? ask.lesson?.opening);
  if (slice) brief.profile = slice;
  if (ask.question?.trim()) brief.question = clip(ask.question.trim(), MAX_QUESTION);
  if (summary?.trim()) brief.summary = clip(summary.trim(), MAX_SUMMARY);
  return fitToBudget(brief);
}

/**
 * The Player's Winning Chances before and after the move, scored as the bar on the Player's screen
 * scores those positions and worded by the same formatter, so the Coach quotes the bar. The
 * Board, Engine Games and Lessons show the Engine's best line in the position on the board: the
 * best candidate before the move, the best reply after it. A Review shows its graded moves' scores,
 * which the desktop passes as `positionBefore` and `positionAfter`. Where the screen hides the bar so
 * it doesn't give the answer away (a Hint, a Lesson, a Puzzle), the brief leaves them out too.
 */
function winningChancesOf(ask: CoachAsk): Brief['winningChances'] {
  if (ask.job === 'hint' || ask.job === 'lesson-turn' || ask.hideWinningChances) return undefined;
  const side = ask.playerSide ?? turnOf(ask.fen);
  const before = ask.positionBefore ?? bestLineScore(ask.fen, ask.candidates);
  if (!before) return undefined;
  const played = ask.move ? playUci(ask.fen, ask.move.uci) : null;
  const after = played ? (ask.positionAfter ?? bestLineScore(played.fenAfter, ask.replies ?? [])) : undefined;
  return {
    before: winningChancesFor(before.score, before.pov, side).text,
    ...(after ? { after: winningChancesFor(after.score, after.pov, side).text } : {}),
  };
}

/** A position's score as the Board's bar shows it: the result once the game is over, otherwise the Engine's best line. */
function bestLineScore(fen: string, lines: readonly Candidate[]): PositionScore | undefined {
  const best = lines[0];
  return finishedScore(fen) ?? (best ? { score: best.score, pov: turnOf(fen) } : undefined);
}

/**
 * Where the brief's threat is played from: the position after the move when there is one, and
 * otherwise `fen` after a pass. The guard checks the threat's move there.
 */
export function threatFen(brief: { fen: string; move?: { uci: string } | undefined }): string | undefined {
  return brief.move ? playUci(brief.fen, brief.move.uci)?.fenAfter : nullMoveFen(brief.fen);
}

/**
 * The opponent's threat as the Engine found it, legal where it would be played. Without a move it
 * is the threat in `fen`. After a move it stays only when the Engine's best reply to the move is
 * still that forcing move, with the Engine's line after it, so the brief states as an Engine fact
 * that the move left the threat on; otherwise the move dealt with it and the Coach isn't told (ADR 0002).
 */
function threatOf(ask: CoachAsk): Brief['threat'] {
  if (!ask.threat) return undefined;
  const from = threatFen(ask);
  if (!from) return undefined;
  if (ask.move) {
    const best = ask.replies?.[0];
    const played = best?.uci === ask.threat.uci ? playUci(from, best.uci) : undefined;
    if (!best || !played || !isForcing(played.san)) return undefined;
    return { by: turnOf(from), san: played.san, uci: played.uci, line: linesSan(played.fenAfter, best.pv.slice(1, LINE_PLIES)), ignored: true };
  }
  const played = playUci(from, ask.threat.uci);
  if (!played) return undefined;
  return { by: turnOf(from), san: played.san, uci: played.uci, line: linesSan(played.fenAfter, ask.threat.pv.slice(1, LINE_PLIES)) };
}

/** The Engine's candidates in `fen`, each graded against `best` and with the facts `explain` gives for it. */
export function briefCandidates(
  fen: string,
  candidates: readonly Candidate[],
  max: number,
  explain: (c: Candidate, index: number) => Facts,
  best: Candidate | undefined = candidates[0],
): BriefCandidate[] {
  const out: BriefCandidate[] = [];
  for (const [i, c] of candidates.slice(0, max).entries()) {
    const played = playUci(fen, c.uci);
    if (!played || !best) continue;
    const line = linesSan(played.fenAfter, c.pv.slice(1, LINE_PLIES));
    out.push({
      san: played.san,
      uci: played.uci,
      evaluation: formatScore(c.score),
      grade: gradeMove({ best: best.score, played: c.score, isTopMove: c.uci === best.uci, givesMate: outcomeOf(played.fenAfter)?.reason === 'checkmate' }).grade,
      line,
      ...explain(c, i),
    });
  }
  return out;
}

export type Facts = Pick<BriefCandidate, 'does' | 'result'>;

/** What a move's facts leave out of the Engine's line after it. */
export interface Withheld {
  /** Its moves: a Hint names none, and neither does a turn that keeps the Lesson's move back. */
  moves?: boolean;
  /** Where a mate ends and what boxes the king in: kept back, the mate can be the Lesson's move. */
  mateDetails?: boolean;
  /**
   * What the line's first move does (a square it goes to, a piece it can take). Kept back, after a
   * reply that move is the Player's next one, which is often the Lesson's.
   */
  nextMove?: boolean;
}

/** The facts that say what the line's first move does, rather than what the move itself does. */
const NEXT_MOVE_FACTS: readonly MoveFact['kind'][] = ['stops-guarding', 'leaves'];

/**
 * The explainability layer's facts for a move from `fen` (see explain.ts): what it does, and, given
 * the Engine's `score` of it for its side, what the forcing moves of the line after it (`line`,
 * starting with the reply) lead to, leaving out what `withheld` says.
 */
export function explained(fen: string, uci: string, line: readonly string[], score?: Score, withheld: Withheld = {}): Facts {
  const out: Facts = {};
  const does = moveFacts(fen, uci, line).filter((f) => !withheld.nextMove || !NEXT_MOVE_FACTS.includes(f.kind));
  if (does.length) out.does = does.map(describeFact).join('; ');
  const result = score && lineOutcome(turnOf(fen), readLine(fen, [uci, ...line]), score);
  if (result && worthSaying(result, fen, score)) {
    const said = withheld.mateDetails && result.mate ? { ...result, mate: { by: result.mate.by, in: result.mate.in } } : result;
    out.result = describeOutcome(said, !withheld.moves);
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
  // Never cut a pair of UTF-16 code units in half (an emoji, say): half a pair is not text.
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * The ways to make a brief smaller, least important first. None of them touches a Lesson's focus: it
 * is what keeps the Coach on the Lesson's point, and the worst case fits with it whole (see the tests).
 */
export const TRIM_STEPS: readonly ((b: Brief) => void)[] = [
  // The facts about the weaker alternatives go first: the best moves, the move and the moves the Player asked about matter most.
  (b) => { b.candidates.slice(2).forEach((c) => { if (!c.asked) delete c.does; }); b.replies?.slice(1).forEach((r) => delete r.does); },
  (b) => { b.candidates.slice(1).forEach((c) => { if (!c.asked) { delete c.does; delete c.result; } }); },
  // The tempting moves the Engine didn't list: their lines short, then their facts but the result.
  (b) => { b.tempting?.forEach((t) => { t.line = t.line.split(' ').slice(0, 2).join(' '); }); },
  (b) => { b.tempting?.forEach((t) => delete t.does); },
  (b) => { if (b.summary) b.summary = clip(b.summary, 250); },
  (b) => { if (b.lesson) b.lesson.notes = clip(b.lesson.notes, 300); },
  (b) => { if (b.profile) b.profile.notes = b.profile.notes.slice(-1); },
  (b) => { b.candidates.forEach((c) => { if (!c.asked) c.line = c.line.split(' ').slice(0, 2).join(' '); }); },
  (b) => { if (b.threat) b.threat.line = b.threat.line.split(' ').slice(0, 2).join(' '); },
  (b) => { if (b.replies) b.replies = b.replies.slice(0, 2); },
  (b) => { b.recentMoves = b.recentMoves.split(' ').slice(-12).join(' '); },
  (b) => { if (b.question) b.question = clip(b.question, 200); },
  (b) => { delete b.profile; },
  (b) => { delete b.summary; },
  (b) => { delete b.tempting; },
  // Last, the facts on the key moves themselves.
  (b) => { b.replies?.forEach((r) => delete r.does); b.candidates.forEach((c) => { delete c.does; delete c.result; }); },
  (b) => { if (b.move) { delete b.move.does; delete b.move.result; } },
];

/** Trims the least important parts until the brief fits. */
function fitToBudget(brief: Brief): Brief {
  for (const step of TRIM_STEPS) {
    if (briefSize(brief) <= BRIEF_BUDGET) break;
    step(brief);
  }
  assertBriefWithinBudget(brief);
  return brief;
}
