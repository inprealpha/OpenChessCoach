import { AppError } from './errors.ts';
import { COACH_QUALITIES, MODEL_JOBS, type CoachQuality, type ModelJob, type Settings, type SettingsPatch } from '@chess-coach/shared/protocol';
import { all, type Db } from './db.ts';

/**
 * The Coach quality presets: the model each Coach job uses under each choice in Settings. Hints and
 * Live Coaching stay on Haiku in every preset, because they must answer quickly. A Review's overview
 * has no model of its own: it runs on the Review moments' model in every preset (`modelJobOf`).
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

/** Balanced: the faster model for Live Coaching and Hints, the stronger one for everything else. */
export const DEFAULT_MODELS: Record<ModelJob, string> = COACH_QUALITY_MODELS.balanced;

/** What the settings table holds. The Coach quality is not stored: it is read from the models. */
type StoredSettings = Omit<Settings, 'quality'>;

const DEFAULT_SETTINGS: StoredSettings = {
  models: DEFAULT_MODELS,
  liveCoachingDefault: true,
  tunnelEnabled: false,
  thinkDeeper: false,
  reviewOverview: true,
};

/** The preset whose models these are, or custom when they match none. */
export function qualityOf(models: Record<ModelJob, string>): Settings['quality'] {
  return COACH_QUALITIES.find((q) => MODEL_JOBS.every((job) => COACH_QUALITY_MODELS[q][job] === models[job])) ?? 'custom';
}

function withQuality(s: StoredSettings): Settings {
  return { ...s, quality: qualityOf(s.models) };
}

function readStored(db: Db): StoredSettings {
  const rows = all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const stored: Partial<StoredSettings> = {};
  for (const r of rows) (stored as Record<string, unknown>)[r.key] = JSON.parse(r.value);
  return {
    models: { ...DEFAULT_MODELS, ...(stored.models ?? {}) },
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
  if (patch.thinkDeeper !== undefined && typeof patch.thinkDeeper !== 'boolean') {
    throw new AppError('bad-request', 'Think deeper is on (true) or off (false).');
  }
  if (patch.reviewOverview !== undefined && typeof patch.reviewOverview !== 'boolean') {
    throw new AppError('bad-request', 'The Review overview is on (true) or off (false).');
  }
  const current = readStored(db);
  const preset = patch.quality === undefined ? {} : presetModels(patch.quality);
  const next: StoredSettings = {
    models: { ...current.models, ...preset, ...cleanModels(patch.models) },
    liveCoachingDefault: patch.liveCoachingDefault ?? current.liveCoachingDefault,
    tunnelEnabled: patch.tunnelEnabled ?? current.tunnelEnabled,
    thinkDeeper: patch.thinkDeeper ?? current.thinkDeeper,
    reviewOverview: patch.reviewOverview ?? current.reviewOverview,
  };
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(next)) put.run(k, JSON.stringify(v));
  return withQuality(next);
}

function presetModels(quality: unknown): Record<ModelJob, string> {
  if (typeof quality !== 'string' || !Object.hasOwn(COACH_QUALITY_MODELS, quality)) {
    throw new AppError('bad-request', 'The Coach quality is Thrifty, Balanced or Best.');
  }
  return COACH_QUALITY_MODELS[quality as CoachQuality];
}

function cleanModels(models: Partial<Record<ModelJob, string>> | undefined): Partial<Record<ModelJob, string>> {
  const out: Partial<Record<ModelJob, string>> = {};
  for (const [job, model] of Object.entries(models ?? {})) {
    if (!Object.hasOwn(DEFAULT_MODELS, job)) throw new AppError('bad-request', `There is no Coach job called "${job}".`);
    if (typeof model !== 'string' || !/^[\w.\-[\]]{1,64}$/.test(model.trim())) {
      throw new AppError('bad-request', 'A model name is a Claude model alias or id, such as sonnet or haiku.');
    }
    out[job as ModelJob] = model.trim();
  }
  return out;
}
