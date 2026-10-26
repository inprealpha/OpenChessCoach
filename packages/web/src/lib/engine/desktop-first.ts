// Coach work runs on the desktop's Engine, so its facts match what the Coach is given (ADR 0007).
import type { ErrorCode } from '@chess-coach/shared/protocol';

/** Errors that mean the desktop's Engine can't be reached, so the browser's Engine stands in. */
const UNREACHABLE: ReadonlySet<ErrorCode | 'offline'> = new Set(['offline', 'engine-unavailable']);

/**
 * Asks the desktop when it is connected, and the browser when it is not or when it drops out or
 * its Engine can't start. Any other error from the desktop is passed on, not hidden.
 */
export async function desktopFirst<T>(connected: boolean, desktop: () => Promise<T>, browser: () => Promise<T>): Promise<T> {
  if (connected) {
    try {
      return await desktop();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (!UNREACHABLE.has(code as ErrorCode)) throw err;
    }
  }
  return browser();
}
