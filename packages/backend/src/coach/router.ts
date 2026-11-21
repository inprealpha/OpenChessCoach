// Multi-provider Coach router: delegates CoachPort calls to the active provider and lets Settings
// switch providers live without disrupting in-flight Coach calls.
import { COACH_PROVIDERS, type CoachProvider, type CoachProviderInfo, type CoachStatus } from '@chess-coach/shared/protocol';
import { CoachUnavailableError, type CoachBack, type CoachCall, type CoachPort } from './port.ts';

export const PROVIDER_LABELS: Record<CoachProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  opencode: 'OpenCode',
};

export interface CoachRouterOptions {
  providers: Partial<Record<CoachProvider, CoachPort>>;
  initial: CoachProvider;
  /** Optional static availability overrides (e.g. when a provider failed startup check). */
  unavailableReasons?: Partial<Record<CoachProvider, string>>;
}

export class CoachRouter implements CoachPort {
  private readonly providers: Partial<Record<CoachProvider, CoachPort>>;
  private readonly unavailableReasons: Partial<Record<CoachProvider, string>>;
  private active: CoachProvider;
  private readonly listeners = new Set<(back: CoachBack) => void>();

  constructor(options: CoachRouterOptions) {
    this.providers = { ...options.providers };
    this.unavailableReasons = { ...options.unavailableReasons };
    this.active = options.initial;
    for (const provider of COACH_PROVIDERS) {
      const port = this.providers[provider];
      port?.watch?.((back) => {
        if (this.active !== provider) return;
        for (const listener of this.listeners) listener(back);
      });
    }
  }

  private get current(): CoachPort | undefined {
    return this.providers[this.active];
  }

  get name(): 'real' | 'codex' | 'pi' | 'opencode' | 'fake' {
    return this.current?.name ?? (this.active === 'claude' ? 'real' : this.active);
  }

  get provider(): CoachProvider {
    return this.active;
  }

  get supportsEngineTool(): boolean {
    return this.current?.supportsEngineTool ?? true;
  }

  async ask(call: CoachCall, onText: (delta: string) => void) {
    const target = this.current;
    if (!target) {
      const reason = this.unavailableReasons[this.active] ?? `${PROVIDER_LABELS[this.active]} is not available on this desktop.`;
      throw new CoachUnavailableError(reason);
    }
    return target.ask(call, onText);
  }

  async status(): Promise<CoachStatus> {
    const target = this.current;
    if (!target) {
      const reason = this.unavailableReasons[this.active] ?? `${PROVIDER_LABELS[this.active]} is not available on this desktop.`;
      return { state: 'unavailable', provider: this.active, reason };
    }
    const s = await target.status();
    return { ...s, provider: s.provider ?? this.active };
  }

  watch(listener: (back: CoachBack) => void): void {
    this.listeners.add(listener);
  }

  /** Switches the active provider; in-flight calls finish on whichever provider they started with. */
  switchProvider(next: CoachProvider): void {
    if (this.active === next) return;
    this.active = next;
    for (const listener of this.listeners) listener({});
  }

  /** Returns live availability for all known Coach backends so Settings can show what is ready. */
  async listProviders(): Promise<CoachProviderInfo[]> {
    return Promise.all(
      COACH_PROVIDERS.map(async (provider): Promise<CoachProviderInfo> => {
        const port = this.providers[provider];
        const supportsEngineTool = port ? port.supportsEngineTool !== false : provider !== 'codex' && provider !== 'opencode';
        if (!port) {
          return {
            provider,
            label: PROVIDER_LABELS[provider],
            available: false,
            reason: this.unavailableReasons[provider] ?? `${PROVIDER_LABELS[provider]} is not available on this desktop.`,
            supportsEngineTool,
          };
        }
        const st = await port.status();
        return {
          provider,
          label: PROVIDER_LABELS[provider],
          available: st.state !== 'unavailable',
          ...(st.reason ? { reason: st.reason } : {}),
          supportsEngineTool,
        };
      }),
    );
  }
}
