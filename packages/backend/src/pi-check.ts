// Checks Pi (`@earendil-works/pi-coding-agent`) local authentication and available models.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type PiCheckResult =
  | { ok: true; providers: string[]; modelCount: number }
  | { ok: false; code: 'not-logged-in' | 'no-models'; message: string };

export interface PiCheckDeps {
  /** Returns authenticated providers and available model count from Pi's local config (`~/.pi/agent`). */
  inspect?: () => Promise<{ providers: string[]; modelCount: number }>;
}

export const PI_LOGIN_FIX = 'Run `pi` in a terminal and use `/login` (or set a provider API key) so Pi has a logged-in model.';

async function defaultInspect(): Promise<{ providers: string[]; modelCount: number }> {
  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailable();
  const providers = Array.from(new Set(available.map((m) => m.provider)));
  return { providers, modelCount: available.length };
}

/**
 * Checks whether Pi has at least one authenticated provider and usable model in `~/.pi/agent`
 * (or environment variables recognized by Pi's `AuthStorage`).
 * Never reads or returns credential values.
 */
export async function checkPi(deps: PiCheckDeps = {}): Promise<PiCheckResult> {
  try {
    const { providers, modelCount } = await (deps.inspect ?? defaultInspect)();
    if (providers.length === 0 || modelCount === 0) {
      return {
        ok: false,
        code: 'not-logged-in',
        message: `Pi has no logged-in provider on the desktop. ${PI_LOGIN_FIX}`,
      };
    }
    return { ok: true, providers, modelCount };
  } catch (err) {
    return {
      ok: false,
      code: 'not-logged-in',
      message: `Could not read Pi configuration on the desktop (${err instanceof Error ? err.message : String(err)}). ${PI_LOGIN_FIX}`,
    };
  }
}

/** True when a Pi error message indicates missing, expired, or rejected credentials. */
export function isPiAuthError(message: string): boolean {
  return /\b(401|403|unauthorized|unauthenticated|no api key|api key|not logged in|invalid[_\s-]?key|token expired|authentication failed|login)\b/i.test(
    message,
  );
}

/** True when a Pi error message indicates a rate or usage limit. */
export function isPiLimitError(message: string): boolean {
  return /\b(429|rate[_\s-]?limit|usage[_\s-]?limit|quota exceeded|too many requests|limit reached)\b/i.test(
    message,
  );
}
