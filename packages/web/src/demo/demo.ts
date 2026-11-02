// A stand-in for the desktop, for a demo build of the web app (VITE_DEMO=1) that runs on its own,
// such as inside a page that shows the trial layouts. It answers the protocol from data recorded
// off a verify-mode desktop (one Imported Game with its Review), keeps what the Player does in
// memory, and sends every Engine request back to the browser's own Engine, as the app does when
// the desktop can't be reached. The Coach doesn't run: it says so where its words would go.
import type { RequestBody, RequestType, ResponseBody, ReviewPart, GameSummary, LessonProgress, PuzzleStats } from '@chess-coach/shared/protocol';
import type { CoachReply } from '@chess-coach/shared/coach/types';
import { ApiError } from '../lib/api.svelte.ts';
import recorded from './recorded.json';

type Delta = (text: string, part?: ReviewPart, status?: string) => void;
type Progress = (done: number, total: number) => void;

const data = structuredClone(recorded) as unknown as {
  hello: ResponseBody<'hello'>;
  pairing: ResponseBody<'pairing.info'>;
  profile: ResponseBody<'profile.get'>;
  settings: ResponseBody<'settings.get'>;
  games: ResponseBody<'games.list'>;
  game1: ResponseBody<'games.get'>;
  review1: ResponseBody<'review.get'>;
  lessons: ResponseBody<'lessons.progress'>;
};

const COACH_TEXT: Record<string, string> = {
  why: 'This is a demo running in your browser, so the Coach isn’t here. On your desktop its answer to your question appears in this place, worked out from the Engine’s lines.',
  hint: 'In this demo the Coach isn’t here: on your desktop a one-line Hint appears in this place. Press the button again to see the Engine’s move.',
  'lesson-turn': 'In this demo the Coach isn’t here: on your desktop it explains this move in this place.',
  live: 'In this demo the Coach isn’t here: on your desktop Live Coaching speaks up here after a Mistake or a Blunder.',
};

const lessons = new Map<string, LessonProgress>(data.lessons.lessons.map((l) => [l.lessonId, l]));
let nextGameId = 100;
const games: GameSummary[] = [...data.games.games];

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function coach(body: RequestBody<'coach.ask'>, onDelta?: Delta): Promise<CoachReply> {
  const text = COACH_TEXT[body.job] ?? COACH_TEXT.why!;
  // Streamed in a few pieces, as the Coach's words arrive.
  const words = text.split(' ');
  for (let i = 0; i < words.length; i += 6) {
    onDelta?.(words.slice(i, i + 6).join(' ') + (i + 6 < words.length ? ' ' : ''));
    await wait(40);
  }
  return { text, moves: [], arrows: [], highlights: [], note: null, stripped: 0, model: 'demo', engineQuestions: 0 };
}

async function handle(type: RequestType, body: Record<string, unknown>, onDelta?: Delta, onProgress?: Progress): Promise<unknown> {
  switch (type) {
    case 'hello':
      return data.hello;
    case 'pairing.info':
      return data.pairing;
    case 'pairing.remindLater':
      return data.pairing.phone;
    case 'profile.get':
    case 'profile.deleteNote':
      return data.profile;
    case 'profile.update':
      Object.assign(data.profile, body);
      return data.profile;
    case 'settings.get':
      return data.settings;
    case 'settings.update':
      Object.assign(data.settings, body);
      return data.settings;
    case 'games.list':
      return { games, total: games.length };
    case 'games.get':
      if (body.gameId === data.game1.id) return data.game1;
      throw new ApiError('not-found', 'In this demo only the sample game can be opened.');
    case 'review.get':
      return body.gameId === data.game1.id ? data.review1 : { review: null, beingMade: false };
    case 'review.start': {
      if (body.gameId !== data.game1.id || !data.review1.review) throw new ApiError('not-found', 'In this demo only the sample game has a Review.');
      const total = data.game1.moves.length;
      for (let done = 0; done <= total; done += 7) {
        onProgress?.(Math.min(done, total), total);
        await wait(30);
      }
      return data.review1.review;
    }
    case 'lessons.progress':
      return { lessons: [...lessons.values()] };
    case 'lessons.update': {
      const p = { ...(lessons.get(body.lessonId as string) ?? {}), ...body } as unknown as LessonProgress;
      lessons.set(p.lessonId, p);
      return p;
    }
    case 'puzzles.record':
      return { solved: 0, attempted: 0, ...(data.profile.puzzles as Partial<PuzzleStats> | undefined) } as unknown as PuzzleStats;
    case 'games.saveEngineGame':
    case 'games.importSample':
    case 'games.importPgn': {
      const game: GameSummary = { ...data.game1, id: nextGameId++, source: 'engine', hasReview: false } as GameSummary;
      return { game, duplicate: false };
    }
    case 'games.syncOffline':
      return { saved: [], duplicates: 0 };
    case 'coach.ask':
      return coach(body as unknown as RequestBody<'coach.ask'>, onDelta);
    case 'engine.analyse':
    case 'engine.grade':
    case 'engine.threat':
      // The browser's own Engine answers, as when the desktop can't be reached.
      throw new ApiError('offline', 'The demo has no desktop Engine.');
    default:
      throw new ApiError('bad-request', 'Not part of this demo.');
  }
}

export const demo = {
  request<K extends RequestType>(type: K, body: RequestBody<K>, onDelta?: Delta, onProgress?: Progress): Promise<ResponseBody<K>> {
    return handle(type, body as Record<string, unknown>, onDelta, onProgress) as Promise<ResponseBody<K>>;
  },
};
