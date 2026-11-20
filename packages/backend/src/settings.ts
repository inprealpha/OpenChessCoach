import { AppError } from './errors.ts';
import {
  COACH_PROVIDERS,
  COACH_QUALITIES,
  MODEL_JOBS,
  type CoachProvider,
  type CoachQuality,
  type ModelJob,
  type Settings,
  type SettingsPatch,
} from '@chess-coach/shared/protocol';
import { all, type Db } from './db.ts';

/**
 * The Coach quality presets for Claude: the model each Coach job uses under each choice in Settings.
 * Hints and Live Coaching stay on Haiku in every preset, because they must answer quickly. A Review's
 * overview has no model of its own: it runs on the Review moments' model in every preset (`modelJobOf`).
 *
 * Every model is a family alias (`haiku`, `sonnet`, `opus`), never a fixed version. The alias goes
 * to the Claude Agent SDK, and the Claude Code it bundles maps it to the newest model of that family
 * it knows. So keeping `@anthropic-ai/claude-agent-sdk` current in `packages/backend/package.json`
 * is what keeps the Coach on the latest models; nothing here needs to change when a model ships.
 */
export const COACH_QUALITY_MODELS: Record<CoachQuality, Record<ModelJob, string>> = {
  thrifty: { 'review-moment': 'haiku', why: 'haiku', 'lesson-turn': 'haiku', hint: 'haiku', live: 'haiku' },
  balanced: { 'review-moment': 'sonnet', why: 'sonnet', 'lesson-turn': 'sonnet', hint: 'haiku', live: 'haiku' },
  best: { 'review-moment': 'opus', why: 'opus', 'lesson-turn': 'opus', hint: 'haiku', live: 'haiku' },
};

/** Per-provider quality presets. `'default'` tells Codex or Pi to use its own configured default model. */
export const PROVIDER_QUALITY_MODELS: Record<CoachProvider, Record<CoachQuality, Record<ModelJob, string>>> = {
  claude: COACH_QUALITY_MODELS,
  codex: {
    thrifty: { 'review-moment': 'gpt-5.4-mini', why: 'gpt-5.4-mini', 'lesson-turn': 'gpt-5.4-mini', hint: 'gpt-5.4-mini', live: 'gpt-5.4-mini' },
    balanced: { 'review-moment': 'gpt-5.4', why: 'gpt-5.4', 'lesson-turn': 'gpt-5.4', hint: 'gpt-5.4-mini', live: 'gpt-5.4-mini' },
    best: { 'review-moment': 'default', why: 'default', 'lesson-turn': 'default', hint: 'default', live: 'default' },
  },
  pi: {
    thrifty: { 'review-moment': 'default', why: 'default', 'lesson-turn': 'default', hint: 'default', live: 'default' },
    balanced: { 'review-moment': 'default', why: 'default', 'lesson-turn': 'default', hint: 'default', live: 'default' },
    best: { 'review-moment': 'default', why: 'default', 'lesson-turn': 'default', hint: 'default', live: 'default' },
  },
};

/**
 * Best: Opus for Reviews, Why Questions and Lessons (the owner's choice for 0.5.0), and Haiku for
 * Live Coaching and Hints, which was measured good enough for the two short jobs
 * (docs/research/hint-and-live-coaching-models.md).
 */
export const DEFAULT_MODELS: Record<ModelJob, string> = COACH_QUALITY_MODELS.best;

export function defaultModelsFor(provider: CoachProvider): Record<ModelJob, string> {
  return PROVIDER_QUALITY_MODELS[provider].best;
}

/** What the settings table holds. The Coach quality is not stored: it is read from the models. */
type StoredSettings = Omit<Settings, 'quality'>;

const DEFAULT_SETTINGS: StoredSettings = {
  coachProvider: 'claude',
  models: DEFAULT_MODELS,
  liveCoachingDefault: true,
  tunnelEnabled: false,
  // On by default: the Coach explains better with the Engine at hand (#32, ADR 0010).
  thinkDeeper: true,
  reviewOverview: true,
};

/** The preset whose models these are for the active provider, or custom when they match none. */
export function qualityOf(models: Record<ModelJob, string>, provider: CoachProvider = 'claude'): Settings['quality'] {
  const presets = PROVIDER_QUALITY_MODELS[provider];
  return COACH_QUALITIES.find((q) => MODEL_JOBS.every((job) => presets[q][job] === models[job])) ?? 'custom';
}

function withQuality(s: StoredSettings): Settings {
  return { ...s, quality: qualityOf(s.models, s.coachProvider) };
}

function readStored(db: Db): StoredSettings {
  const rows = all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const stored: Partial<StoredSettings> = {};
  for (const r of rows) (stored as Record<string, unknown>)[r.key] = JSON.parse(r.value);
  const coachProvider: CoachProvider =
    typeof stored.coachProvider === 'string' && (COACH_PROVIDERS as readonly string[]).includes(stored.coachProvider)
      ? stored.coachProvider
      : DEFAULT_SETTINGS.coachProvider;
  const fallbackModels = defaultModelsFor(coachProvider);
  return {
    coachProvider,
    models: { ...fallbackModels, ...(stored.models ?? {}) },
    liveCoachingDefault: stored.liveCoachingDefault ?? DEFAULT_SETTINGS.liveCoachingDefault,
    tunnelEnabled: stored.tunnelEnabled ?? DEFAULT_SETTINGS.tunnelEnabled,
    thinkDeeper: stored.thinkDeeper ?? DEFAULT_SETTINGS.thinkDeeper,
    reviewOverview: stored.reviewOverview ?? DEFAULT_SETTINGS.reviewOverview,
  };
}

export function getSettings(db: Db): Settings {
  return withQuality(readStored(db));
}

export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  if (patch.coachProvider !== undefined && (typeof patch.coachProvider !== 'string' || !(COACH_PROVIDERS as readonly string[]).includes(patch.coachProvider))) {
    throw new AppError('bad-request', 'The Coach backend is Claude, Codex or Pi.');
  }
  if (patch.thinkDeeper !== undefined && typeof patch.thinkDeeper !== 'boolean') {
    throw new AppError('bad-request', 'Think deeper is on (true) or off (false).');
  }
  if (patch.reviewOverview !== undefined && typeof patch.reviewOverview !== 'boolean') {
    throw new AppError('bad-request', 'The Review overview is on (true) or off (false).');
  }
  const current = readStored(db);
  const nextProvider = patch.coachProvider ?? current.coachProvider;
  const providerChanged = patch.coachProvider !== undefined && patch.coachProvider !== current.coachProvider;
  const baseModels = providerChanged ? defaultModelsFor(nextProvider) : current.models;
  const preset = patch.quality === undefined ? {} : presetModels(patch.quality, nextProvider);
  const next: StoredSettings = {
    coachProvider: nextProvider,
    models: { ...baseModels, ...preset, ...cleanModels(patch.models) },
    liveCoachingDefault: patch.liveCoachingDefault ?? current.liveCoachingDefault,
    tunnelEnabled: patch.tunnelEnabled ?? current.tunnelEnabled,
    thinkDeeper: patch.thinkDeeper ?? current.thinkDeeper,
    reviewOverview: patch.reviewOverview ?? current.reviewOverview,
  };
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  // Only what the Player changed is stored: a setting never touched follows its default, so a new
  // default reaches every install without a migration (#32).
  const touched = new Set<string>(Object.keys(patch).map((k) => (k === 'quality' ? 'models' : k)));
  if (providerChanged) touched.add('models');
  for (const [k, v] of Object.entries(next)) if (touched.has(k)) put.run(k, JSON.stringify(v));
  return withQuality(next);
}

function presetModels(quality: unknown, provider: CoachProvider): Record<ModelJob, string> {
  if (typeof quality !== 'string' || !Object.hasOwn(COACH_QUALITY_MODELS, quality)) {
    throw new AppError('bad-request', 'The Coach quality is Thrifty, Balanced or Best.');
  }
  return PROVIDER_QUALITY_MODELS[provider][quality as CoachQuality];
}

function cleanModels(models: Partial<Record<ModelJob, string>> | undefined): Partial<Record<ModelJob, string>> {
  const out: Partial<Record<ModelJob, string>> = {};
  for (const [job, model] of Object.entries(models ?? {})) {
    if (!Object.hasOwn(DEFAULT_MODELS, job)) throw new AppError('bad-request', `There is no Coach job called "${job}".`);
    if (typeof model !== 'string' || !/^[\w.\-[\]/:]{1,128}$/.test(model.trim())) {
      throw new AppError('bad-request', 'A model name is a model alias or id, such as sonnet, gpt-5.4 or default.');
    }
    out[job as ModelJob] = model.trim();
  }
  return out;
}
