import type { RequestBody, RequestType, ResponseBody, ServerEvent } from '@chess-coach/shared/protocol';
import type { Clock } from '../clock.ts';
import type { Db } from '../db.ts';
import type { Pairing, Device } from '../pairing.ts';
import type { CoachService } from '../coach/service.ts';
import type { EngineService } from '../engine/service.ts';
import type { EngineConfig } from '../server.ts';
import type { TunnelManager } from '../tunnel.ts';
import { coachHandlers } from './coach.ts';
import { engineHandlers } from './engine.ts';
import { gameHandlers } from './games.ts';
import { lessonHandlers } from './lessons.ts';
import { profileHandlers } from './profile.ts';
import { systemHandlers } from './system.ts';

export interface AppContext {
  db: Db;
  clock: Clock;
  pairing: Pairing;
  coach: CoachService;
  /** The desktop's Engine, for Reviews, Lesson turns and every Coach brief (ADR 0007). */
  desktopEngine: EngineService;
  verify: boolean;
  version: string;
  engine: EngineConfig;
  lanUrl: string;
  localUrl: string;
  tunnel: TunnelManager;
  fetch: typeof fetch;
  broadcast: (event: ServerEvent) => void;
  /** Closes connections whose token is no longer valid. */
  revalidate: () => void;
  /** Aborted when the app closes, for work that outlives its request, such as a Review. */
  stopping: AbortSignal;
  log: (line: string) => void;
}

export interface RequestContext {
  app: AppContext;
  device: Device;
  signal: AbortSignal;
  /**
   * Whether the connection is still open. False as soon as its close arrives, which can be before
   * `signal` aborts: once closing, the app has told the Player the request failed.
   */
  connected: () => boolean;
  /** Streams a chunk of Coach text for this request. */
  delta: (text: string, part?: number) => void;
  /** Reports how far the desktop has got with this request; a total of 0 means it isn't known yet. */
  progress: (done: number, total: number) => void;
  /** Replaces this connection's token, after a pairing reset. */
  setToken: (token: string) => void;
}

export type Handler<K extends RequestType> = (req: RequestBody<K>, ctx: RequestContext) => Promise<ResponseBody<K>>;
export type HandlerMap<K extends RequestType = RequestType> = { [P in K]: Handler<P> };

export const handlers: HandlerMap = {
  ...systemHandlers,
  ...profileHandlers,
  ...gameHandlers,
  ...lessonHandlers,
  ...coachHandlers,
  ...engineHandlers,
};
