// The real-Coach check (ADR 0006). It needs the owner's Claude login (ADR 0001): the Verdict job
// runs it with the owner's token (ADR 0013), and the owner's desktop can run it too. It starts a
// verify-mode instance with the real Coach in place of the fake one, makes one call of every Coach
// job through the protocol (a Review's overview and key moments through a Review of the seeded game),
// and Lesson calls that carry a Lesson's focus as the Lesson screen sends them (ADR 0012: a Lesson
// turn in an opening and in a Theme, a Lesson turn on a move that isn't the Lesson's, and a Hint in
// a way-of-thinking Lesson). It checks only structure, so the verdict doesn't flip when the Coach
// words something differently:
//   - every move a reply shows is legal and came from the Engine (the move guard, ADR 0002), the
//     briefed threat included, where the guard plays it, and with Think deeper on the Engine's
//     answers to the Coach's questions (ADR 0010);
//   - every piece move named in the text appears in the brief or those answers, so it came from
//     the Engine, the game or the bundled Lesson notes;
//   - a Lesson turn on a move that isn't the Lesson's neither names nor shows the Lesson's move;
//   - each reply stays within its length budget (with 25% slack; over the budget alone is a warning);
//   - replies avoid the terms CONTEXT.md says to avoid (a stray one is a warning: the wording is
//     the model's, and the reply has already streamed to the Player), except the ones that
//     mean the Coach broke role, such as "As an AI assistant, I can't…", which fail.
// The posted status counts the warnings, so a pass with warnings never reads as a clean one.
// Every call runs on the latest Haiku (the `haiku` alias), whatever model the job uses in the app,
// to keep the check cheap on the owner's subscription.
//
//   node scripts/real-coach-check.ts                          run the check (default: claude / haiku) and print the verdict as JSON
//   node scripts/real-coach-check.ts --provider pi            run against another local Coach backend (codex, pi, opencode)
//   node scripts/real-coach-check.ts --provider pi --model X  override the model used for the check
//   node scripts/real-coach-check.ts --post                   also post it as the "real Coach" status on HEAD
//   node scripts/real-coach-check.ts --fake                   drive the same calls with the fake Coach, to test this script
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { legalMoves, playSan, playUci, sanLine, sansIn } from '@chess-coach/shared/chess';
import { allowedMoves, answeredMoves, askedLineMoves, guardReply } from '@chess-coach/shared/coach/guard';
import { answerMoves, type EngineAnswer, type EngineQuestion } from '@chess-coach/shared/coach/engine-tool';
import { MAX_WORDS, threatFen, type Brief } from '@chess-coach/shared/coach/brief';
import type { CoachRequest, CoachRawReply, CoachReply } from '@chess-coach/shared/coach/types';
import type { LessonData, LessonPart } from '@chess-coach/shared/content/lessons';
import { COACH_PROVIDERS, type CoachJob, type CoachProvider } from '@chess-coach/shared/protocol';
import { CoachClient } from '../packages/backend/src/client.ts';
import type { CoachCall, CoachEngine, CoachPort } from '../packages/backend/src/coach/port.ts';
import { avoidedTerms } from './glossary-lint.ts';
import { hasProviderCredentials, isRetryableProviderFailure, isWeakerJudge, materializeCodexAuth, resolveProviderOrder, withOpenCodeEnv } from './ci-providers.ts';

export const STATUS_CONTEXT = 'real Coach';
/** The model every call in the check uses: Claude Code resolves the alias to the latest Haiku. */
export const CHECK_MODEL = 'haiku';
const SLACK = 1.25;
/**
 * Avoided terms that mean the Coach stepped out of its role: a refusal, or talk about itself as an
 * AI or about "the user". That is a structural failure, not a wording slip, so these fail the check.
 */
export const ROLE_BREAK_TERMS: readonly string[] = ['ai', 'assistant', 'user'];
/** GitHub's limit on a commit status description. */
const MAX_DESCRIPTION = 140;

export interface CoachCallRecord {
  job: CoachJob;
  brief: Brief;
  raw: CoachRawReply;
  /** With Think deeper on, the Engine's answers to the Coach's questions in the call. */
  answers?: EngineAnswer[];
}

export interface CallVerdict {
  job: CoachJob;
  words: number;
  maxWords: number;
  problems: string[];
  warnings: string[];
}

/** A move a reply must not give away: the Lesson's move, when the Player played another (UCI and SAN). */
export interface KeptBack {
  uci: string;
  san: string;
}

/** A reply as the client received it, with the moves it must not give away. */
interface Received {
  job: CoachJob;
  reply: CoachReply;
  keptBack?: KeptBack[];
}

/**
 * The structural checks for one Coach call: the brief it got, its raw reply and what the client
 * received, and the moves the reply must not give away.
 */
export function checkCall(record: CoachCallRecord, reply: CoachReply, terms: readonly string[], keptBack: readonly KeptBack[] = []): CallVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { brief } = record;
  const answers = record.answers ?? [];
  const fromAnswers = answeredMoves(brief, answers.flatMap(answerMoves));

  const allowed = brief.hideMoves ? new Set<string>() : new Set([...allowedMoves(brief), ...fromAnswers.drawn]);
  // An asked move's line may be named, never drawn: the guard checks each move where the line plays it.
  // So may a move deeper in a line in the Engine's answers.
  const named = brief.hideMoves ? new Set<string>() : new Set([...askedLineMoves(brief), ...fromAnswers.named]);
  for (const uci of [...reply.moves.filter((m) => !named.has(m)), ...reply.arrows.map((a) => `${a.from}${a.to}`)]) {
    // A Review's overview names moves from all over the game: each must be one its brief lists.
    if (brief.game) {
      if (!allowed.has(uci)) problems.push(`the overview shows ${uci}, which its brief doesn't list`);
      continue;
    }
    // Legal in the position, after the move, or, for the briefed threat, where the guard plays it.
    const threatFrom = uci === brief.threat?.uci ? threatFen(brief) : undefined;
    const legal =
      playUci(brief.fen, uci) ??
      (brief.move ? playUci(playUci(brief.fen, brief.move.uci)?.fenAfter ?? brief.fen, uci) : undefined) ??
      (threatFrom ? playUci(threatFrom, uci) : undefined);
    if (!legal) problems.push(`the reply shows ${uci}, which is not legal here`);
    else if (!allowed.has(uci) && ![...allowed].some((a) => a.slice(0, 4) === uci)) problems.push(`the reply shows ${uci}, which the Engine never suggested`);
  }
  const stripped = guardReply(brief, record.raw, answers.flatMap(answerMoves)).stripped;
  if (stripped.length) warnings.push(`the move guard stripped what the Engine never suggested: ${stripped.join('; ')}`);

  const briefText = JSON.stringify([brief, ...answers]);
  for (const san of new Set(sansIn(reply.text))) {
    if (brief.hideMoves) problems.push(`the Hint names the move ${san}`);
    else if (!briefText.includes(san)) problems.push(`the text names ${san}, which is not in the brief`);
  }

  // The brief keeps the Lesson's move back while the Player may try again: neither in the text nor on the board.
  for (const k of keptBack) {
    const shown = [...reply.moves, ...reply.arrows.map((a) => `${a.from}${a.to}`)].includes(k.uci);
    // As a word of its own, not inside "Nxe4". A pawn push such as "e4" reads like a square, so only
    // its arrow or its place in the reply's moves gives it away.
    const san = k.san.replace(/[+#]$/, '');
    const said = !/^[a-h][1-8]/.test(san) && new RegExp(`(?<![\\w-])${san.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(reply.text);
    if (shown || said) problems.push(`the reply gives away ${k.san}, which the brief keeps back`);
  }

  const words = reply.text.split(/\s+/).filter(Boolean).length;
  if (words > brief.maxWords * SLACK) problems.push(`${words} words, over the ${brief.maxWords}-word budget by more than ${Math.round((SLACK - 1) * 100)}%`);
  else if (words > brief.maxWords) warnings.push(`${words} words, over the ${brief.maxWords}-word budget`);
  if (!reply.text.trim()) problems.push('the reply is empty');

  const lower = reply.text.toLowerCase();
  for (const term of terms) {
    if (!new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(lower)) continue;
    if (ROLE_BREAK_TERMS.includes(term)) problems.push(`the text uses "${term}", so the Coach broke role`);
    else warnings.push(`the text uses "${term}", which CONTEXT.md says to avoid`);
  }
  return { job: record.job, words, maxWords: brief.maxWords, problems, warnings };
}

/** Wraps a Coach, runs every call on one model and keeps every brief and raw reply. */
export class RecordingCoach implements CoachPort {
  readonly name: CoachPort['name'];
  readonly supportsEngineTool?: boolean;
  readonly calls: CoachCallRecord[] = [];
  private readonly inner: CoachPort;
  private readonly model: string;

  constructor(inner: CoachPort, model = CHECK_MODEL) {
    this.inner = inner;
    this.name = inner.name;
    this.supportsEngineTool = inner.supportsEngineTool;
    this.model = model;
  }

  status() {
    return this.inner.status();
  }

  async ask(call: CoachCall, onText: (delta: string) => void): Promise<CoachRawReply> {
    const answers: EngineAnswer[] = [];
    const engine = call.engine && recordAnswers(call.engine, answers);
    const raw = await this.inner.ask({ ...call, model: this.model, ...(engine ? { engine } : {}) }, onText);
    this.calls.push({ job: call.job, brief: call.brief, raw, ...(call.engine ? { answers } : {}) });
    return raw;
  }
}

/** The Engine tool, keeping each answer it gives. */
function recordAnswers(engine: CoachEngine, answers: EngineAnswer[]): CoachEngine {
  return {
    maxQuestions: engine.maxQuestions,
    maxCalls: engine.maxCalls,
    get exhausted() {
      return engine.exhausted;
    },
    async ask(question: EngineQuestion) {
      const out = await engine.ask(question);
      if (!out.refused) answers.push(JSON.parse(out.text) as EngineAnswer);
      return out;
    },
  };
}

const ITALIAN_BEFORE_BC4 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const AFTER_E4_D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const ITALIAN_AFTER_ND4 = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

/**
 * One call of every Coach job, the way the web app makes them: the position and the move only.
 * The instance's own Engine works out the facts (ADR 0007).
 */
async function driveEveryJob(client: CoachClient, root: URL): Promise<Received[]> {
  const out: Received[] = [];
  const uciOf = (fen: string, san: string): string => {
    const played = playSan(fen, san);
    if (!played) throw new Error(`${san} is not legal in ${fen}`);
    return played.uci;
  };

  // Why Question and Live Coaching: 2.Nf3?? after 1.e4 d5, a Blunder.
  const nf3 = uciOf(AFTER_E4_D5, 'Nf3');
  for (const job of ['why', 'live'] as const) {
    const ask: CoachRequest = { job, fen: AFTER_E4_D5, recentMoves: ['e4', 'd5'], playerSide: 'white', moveUci: nf3 };
    out.push({ job, reply: await client.request('coach.ask', job === 'why' ? { ...ask, question: 'Why is this a mistake?' } : ask) });
  }

  // Hint: the same position before White's move.
  out.push({ job: 'hint', reply: await client.request('coach.ask', { job: 'hint', fen: AFTER_E4_D5, recentMoves: ['e4', 'd5'], playerSide: 'white' }) });

  // A Why Question about that position, with no move: Black's threat dxe4 is legal there only after a pass.
  out.push({ job: 'why', reply: await client.request('coach.ask', { job: 'why', fen: AFTER_E4_D5, recentMoves: ['e4', 'd5'], playerSide: 'white', question: 'What are the options in this position?' }) });

  // A Why Question about a move the Engine doesn't list: 4.Nxe5 instead of 4.O-O after 3...Nd4.
  out.push({
    job: 'why',
    reply: await client.request('coach.ask', {
      job: 'why',
      fen: ITALIAN_AFTER_ND4,
      recentMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'],
      playerSide: 'white',
      moveUci: uciOf(ITALIAN_AFTER_ND4, 'O-O'),
      question: 'Why not Nxe5?',
    }),
  });

  // Lesson turns, each with its Lesson's learning goal and the part's key idea, as every Coach call
  // in a Lesson carries them (ADR 0012). First the Italian Game's 3.Bc4, with its bundled notes.
  const readLesson = (id: string) => JSON.parse(readFileSync(new URL(`data/lessons/${id}.json`, root), 'utf8')) as LessonData;
  const focusOf = (lesson: LessonData, part: LessonPart | undefined) => ({ lesson: lesson.name, learningGoal: lesson.goal, keyIdea: part?.keyIdea ?? '' });
  /** A part's first decision, and the moves played before it from the part's position, as the Lesson screen sends them. */
  const firstDecision = (lesson: LessonData) => {
    const part = lesson.parts[0];
    const node = part?.nodes.find((n) => n.decision);
    if (!part || !node) throw new Error(`The ${lesson.name} Lesson has no decision.`);
    return { part, node, recentMoves: sanLine(part.fen, part.mainLine.slice(0, node.ply)) };
  };
  const lesson = readLesson('italian-game');
  const node = lesson.parts[0]?.nodes.find((n) => n.ply === 4);
  out.push({
    job: 'lesson-turn',
    reply: await client.request('coach.ask', {
      job: 'lesson-turn',
      fen: ITALIAN_BEFORE_BC4,
      recentMoves: ['e4', 'e5', 'Nf3', 'Nc6'],
      playerSide: 'white',
      moveUci: uciOf(ITALIAN_BEFORE_BC4, 'Bc4'),
      lesson: { lessonId: lesson.id, opening: lesson.name, notes: node?.notes?.text ?? '', popularity: (node?.popular.casual ?? []).map((p) => ({ san: p.san, percent: p.percent })), finalTurn: false },
      lessonFocus: focusOf(lesson, lesson.parts[0]),
      opening: lesson.name,
    }),
  });

  // Then a Theme: the Forks Lesson's first decision, where the Coach has to explain the key idea
  // from the Engine's facts. The part starts with the opponent's move, which the screen sends too.
  const forks = readLesson('forks');
  const fork = firstDecision(forks);
  const forkTurn: CoachRequest = {
    job: 'lesson-turn',
    fen: fork.node.fen,
    recentMoves: fork.recentMoves,
    playerSide: fork.part.side,
    moveUci: fork.node.main,
    lesson: { lessonId: forks.id, opening: forks.name, notes: fork.node.notes?.text ?? '', popularity: [], finalTurn: false, isLessonMove: true },
    lessonFocus: focusOf(forks, fork.part),
  };
  out.push({ job: 'lesson-turn', reply: await client.request('coach.ask', forkTurn) });

  // The same decision with a move that isn't the Lesson's: the Player may try again, so the brief
  // keeps the Lesson's move back and the reply must not give it away.
  const other = legalMoves(fork.node.fen).find((uci) => uci !== fork.node.main);
  if (!other || !forkTurn.lesson) throw new Error('The Forks Lesson’s first decision has no other move.');
  out.push({
    job: 'lesson-turn',
    keptBack: [{ uci: fork.node.main, san: fork.node.mainSan }],
    reply: await client.request('coach.ask', { ...forkTurn, moveUci: other, lesson: { ...forkTurn.lesson, isLessonMove: false } }),
  });

  // A Hint in a way-of-thinking Lesson: it may point to the key idea, but still names no move.
  const blunderCheck = readLesson('blunder-check');
  const check = firstDecision(blunderCheck);
  out.push({
    job: 'hint',
    reply: await client.request('coach.ask', {
      job: 'hint',
      fen: check.node.fen,
      recentMoves: check.recentMoves,
      playerSide: check.part.side,
      lessonFocus: focusOf(blunderCheck, check.part),
    }),
  });

  // Review: the seeded Imported Game, graded on the instance. The overview is one review-overview
  // call, made first, and each key moment one review-moment call.
  const [game] = (await client.request('games.list', {})).games;
  if (!game) throw new Error('The seed has no game to review.');
  const review = await client.request('review.start', { gameId: game.id });
  if (review.overview) {
    out.push({ job: 'review-overview', reply: { text: review.overview.text, moves: [], arrows: [], highlights: [], note: null, stripped: 0, model: '', engineQuestions: 0 } });
  }
  for (const m of review.moments) {
    out.push({ job: 'review-moment', reply: { text: m.explanation, moves: [], arrows: [], highlights: [], note: null, stripped: 0, model: '', engineQuestions: 0 } });
  }

  // Think deeper (ADR 0010): a Why Question the brief alone doesn't settle, so the Coach may ask the Engine.
  await client.request('settings.update', { thinkDeeper: true });
  out.push({
    job: 'why',
    reply: await client.request('coach.ask', {
      job: 'why',
      fen: AFTER_E4_D5,
      recentMoves: ['e4', 'd5'],
      playerSide: 'white',
      moveUci: nf3,
      question: 'After dxe4, can I win the pawn back?',
    }),
  });
  await client.request('settings.update', { thinkDeeper: false });
  return out;
}

export interface Verdict {
  ok: boolean;
  sha: string;
  provider?: CoachProvider;
  weakerFallback?: boolean;
  calls: CallVerdict[];
  description: string;
}

/** The run's verdict: any problem fails it, and the status it posts counts the warnings. */
export function summarize(calls: readonly CallVerdict[], providerTag?: string): { ok: boolean; description: string } {
  const prefix = providerTag ? `[${providerTag}] ` : '';
  const failed = calls.filter((c) => c.problems.length);
  if (failed.length) return { ok: false, description: `${prefix}${failed.length} of ${calls.length} Coach calls failed: ${failed[0]?.problems[0] ?? ''}`.slice(0, MAX_DESCRIPTION - 1) };
  const passed = `${prefix}${calls.length} Coach ${calls.length === 1 ? 'call' : 'calls'} passed the structural checks`;
  const warnings = calls.flatMap((c) => c.warnings);
  if (!warnings.length) return { ok: true, description: passed };
  return { ok: true, description: `${passed}, ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}: ${warnings[0]}`.slice(0, MAX_DESCRIPTION - 1) };
}

export type RealCoachProviderArg = CoachProvider | 'auto';

export interface RealCoachArgs {
  fake: boolean;
  post: boolean;
  provider: RealCoachProviderArg;
  model: string;
}

export function parseRealCoachArgs(argv: readonly string[]): RealCoachArgs {
  let fake = false;
  let postResult = false;
  let provider: RealCoachProviderArg = 'claude';
  let model: string | undefined;
  const validProviders: readonly string[] = [...COACH_PROVIDERS, 'auto'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fake') {
      fake = true;
    } else if (arg === '--post') {
      postResult = true;
    } else if (arg === '--provider') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for --provider. Expected one of: ${validProviders.join(', ')}.`);
      }
      if (!validProviders.includes(next)) {
        throw new Error(`Unknown provider "${next}". Expected one of: ${validProviders.join(', ')}.`);
      }
      provider = next as RealCoachProviderArg;
    } else if (arg === '--model') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --model.');
      }
      model = next;
    }
  }
  return {
    fake,
    post: postResult,
    provider,
    model: model ?? (provider === 'claude' ? CHECK_MODEL : 'default'),
  };
}

async function createProviderCoach(
  provider: CoachProvider,
): Promise<{ coach: CoachPort; close?: () => void | Promise<void> }> {
  if (provider === 'claude') {
    const { RealCoach } = await import('../packages/backend/src/coach/real.ts');
    return { coach: new RealCoach() };
  }
  if (provider === 'codex') {
    const { checkCodex } = await import('../packages/backend/src/codex-check.ts');
    const { CodexCoach } = await import('../packages/backend/src/coach/codex.ts');
    const check = await checkCodex();
    if (!check.ok) throw new Error(check.message);
    return { coach: new CodexCoach(check.path ? { codexPath: check.path } : {}) };
  }
  if (provider === 'pi') {
    const { checkPi } = await import('../packages/backend/src/pi-check.ts');
    const { PiCoach } = await import('../packages/backend/src/coach/pi.ts');
    const check = await checkPi();
    if (!check.ok) throw new Error(check.message);
    return { coach: new PiCoach() };
  }
  const { checkOpenCode } = await import('../packages/backend/src/opencode-check.ts');
  const { OpenCodeCoach } = await import('../packages/backend/src/coach/opencode.ts');
  const check = await checkOpenCode();
  if (!check.ok) throw new Error(check.message);
  const openCode = new OpenCodeCoach(check.path ? { opencodePath: check.path } : {});
  return { coach: openCode, close: () => openCode.close() };
}

const DEFAULT_FREE_OPENCODE_TIMEOUT_MS = 90_000;
const DEFAULT_PAID_PROVIDER_TIMEOUT_MS = 300_000;

function providerTimeoutMs(provider: CoachProvider, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REAL_COACH_PROVIDER_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return provider === 'opencode' && isWeakerJudge('opencode', env)
    ? DEFAULT_FREE_OPENCODE_TIMEOUT_MS
    : DEFAULT_PAID_PROVIDER_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: 'coach-unavailable' }));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runSingleProvider(args: { fake: boolean; provider: CoachProvider; model: string; tagProvider?: boolean }): Promise<Verdict> {
  const root = new URL('../', import.meta.url);
  const { FakeCoach } = await import('../packages/backend/src/coach/fake.ts');
  const { startVerifyInstance } = await import('../packages/backend/src/verify/instance.ts');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const codexAuth = !args.fake && args.provider === 'codex' ? materializeCodexAuth() : undefined;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousOpenCodeKey = process.env.OPENCODE_API_KEY;
  if (codexAuth?.codexHome) process.env.CODEX_HOME = codexAuth.codexHome;
  const mappedOpenCodeKey =
    !args.fake && args.provider === 'opencode'
      ? withOpenCodeEnv(process.env).OPENCODE_API_KEY
      : undefined;
  if (mappedOpenCodeKey && !previousOpenCodeKey?.trim()) {
    process.env.OPENCODE_API_KEY = mappedOpenCodeKey;
  }
  const timeoutMs = args.fake ? DEFAULT_PAID_PROVIDER_TIMEOUT_MS : providerTimeoutMs(args.provider);
  let created: { coach: CoachPort; close?: () => void | Promise<void> } | undefined;
  try {
    created = args.fake
      ? { coach: new FakeCoach({ chunkDelayMs: 0 }) }
      : await createProviderCoach(args.provider);
    const coach = new RecordingCoach(created.coach, args.model);
    const status = await coach.status();
    if (status.state !== 'ready') {
      throw new Error(`The real Coach (${args.provider}) is not ready: ${'reason' in status ? status.reason : status.state}.`);
    }

    const instance = await startVerifyInstance({ coachPort: coach, seed: 'default' });
    let received: Received[];
    try {
      const client = await CoachClient.connect(instance.url, instance.token);
      try {
        received = await withTimeout(
          driveEveryJob(client, root),
          timeoutMs,
          `real Coach (${args.provider}) timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      } finally {
        await client.close();
      }
    } finally {
      await instance.stop();
    }

    const terms = avoidedTerms(readFileSync(new URL('CONTEXT.md', root), 'utf8'));
    // A Review's overview and key moments reach the client inside the Review, in the order the Coach was called.
    const inReview = (job: CoachJob) => job === 'review-overview' || job === 'review-moment';
    const reviewReplies = received.filter((r) => inReview(r.job));
    const others = received.filter((r) => !inReview(r.job));
    const calls = coach.calls.map((record) => {
      const reply = inReview(record.job) ? reviewReplies.shift() : others.shift();
      if (!reply) return { job: record.job, words: 0, maxWords: MAX_WORDS[record.job], problems: ['no reply reached the client'], warnings: [] };
      return checkCall(record, reply.reply, terms, reply.keptBack);
    });
    const jobs = new Set(calls.map((c) => c.job));
    const missing = (Object.keys(MAX_WORDS) as CoachJob[]).filter((j) => !jobs.has(j));
    if (missing.length) calls.push({ job: missing[0] as CoachJob, words: 0, maxWords: 0, problems: [`no Coach call was made for ${missing.join(', ')}`], warnings: [] });
    const weakerFallback = !args.fake && args.provider === 'opencode' && isWeakerJudge('opencode');
    const providerTag = args.tagProvider && !args.fake ? (weakerFallback ? 'opencode free' : args.provider) : undefined;
    const { ok, description } = summarize(calls, providerTag);
    return { ok, sha, ...(args.fake ? {} : { provider: args.provider, weakerFallback }), calls, description };
  } finally {
    await created?.close?.();
    if (codexAuth?.codexHome) {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
    if (mappedOpenCodeKey && !previousOpenCodeKey?.trim()) {
      if (previousOpenCodeKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousOpenCodeKey;
    }
    codexAuth?.restore();
  }
}

function isCoachUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { code?: unknown; cause?: unknown };
  if (record.code === 'coach-unavailable') return true;
  if (record.cause && typeof record.cause === 'object' && (record.cause as { code?: unknown }).code === 'coach-unavailable') {
    return true;
  }
  return false;
}

export async function runWithFallback(
  order: readonly CoachProvider[],
  tryProvider: (provider: CoachProvider) => Promise<Verdict>,
  isConfigured: (provider: CoachProvider) => boolean = (p) => hasProviderCredentials(p).configured,
): Promise<Verdict> {
  const errors: string[] = [];
  for (const provider of order) {
    if (!isConfigured(provider)) {
      errors.push(`${provider}: skipped (no credentials configured)`);
      continue;
    }
    try {
      return await tryProvider(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCoachUnavailableError(err) || isRetryableProviderFailure(message) || /is not ready|not logged in|not installed/i.test(message)) {
        errors.push(`${provider}: ${message}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`No real-Coach provider succeeded (${errors.join('; ')}).`);
}

async function run(args: Pick<RealCoachArgs, 'fake' | 'provider' | 'model'>): Promise<Verdict> {
  if (args.fake) {
    return runSingleProvider({ fake: true, provider: 'claude', model: args.model });
  }
  if (args.provider !== 'auto') {
    return runSingleProvider({ fake: false, provider: args.provider, model: args.model });
  }
  const order = resolveProviderOrder('coach', process.env);
  return runWithFallback(order, (provider) =>
    runSingleProvider({
      fake: false,
      provider,
      model: provider === 'claude' ? CHECK_MODEL : 'default',
      tagProvider: true,
    }),
  );
}

function post(verdict: Verdict): void {
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) {
    throw new Error('The working tree has changes, so the verdict would not match the commit. Commit or stash them, then run again.');
  }
  execFileSync('gh', ['api', `repos/{owner}/{repo}/statuses/${verdict.sha}`, '-f', `state=${verdict.ok ? 'success' : 'failure'}`, '-f', `context=${STATUS_CONTEXT}`, '-f', `description=${verdict.description}`], { stdio: 'inherit' });
}

function hasPassingRealCoachStatus(sha: string): boolean {
  try {
    const state = execFileSync(
      'gh',
      ['api', `repos/{owner}/{repo}/commits/${sha}/status`, '--jq', `[.statuses[] | select(.context == "${STATUS_CONTEXT}")][0].state // ""`],
      { encoding: 'utf8' },
    ).trim();
    return state === 'success';
  } catch {
    return false;
  }
}

function postErrorStatus(description: string): void {
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) return;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (hasPassingRealCoachStatus(sha)) return;
  const clipped = description.length <= MAX_DESCRIPTION ? description : `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  execFileSync(
    'gh',
    ['api', `repos/{owner}/{repo}/statuses/${sha}`, '-f', 'state=error', '-f', `context=${STATUS_CONTEXT}`, '-f', `description=${clipped}`],
    { stdio: 'inherit' },
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { quietSqliteWarning } = await import('../packages/backend/src/runtime.ts');
  quietSqliteWarning();
  let parsedArgs: RealCoachArgs | undefined;
  try {
    parsedArgs = parseRealCoachArgs(process.argv.slice(2));
    const verdict = await run(parsedArgs);
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    if (parsedArgs.post) {
      if (parsedArgs.fake) throw new Error('A run with the fake Coach is never posted as the real-Coach verdict.');
      post(verdict);
    }
    process.exit(verdict.ok ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    if (parsedArgs?.post && !parsedArgs.fake) {
      try {
        postErrorStatus(message);
      } catch {
        // Best-effort status posting; preserve exit code 2.
      }
    }
    process.exit(2);
  }
}
