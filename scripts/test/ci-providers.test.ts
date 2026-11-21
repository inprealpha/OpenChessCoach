// Tests for multi-provider CI fallback, judge runner, real-Coach auto fallback, and weekly health check (ADR 0013).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyProviderFailure,
  decodeAuthJson,
  DEFAULT_COACH_CHECK_ORDER,
  DEFAULT_JUDGE_ORDER,
  hasProviderCredentials,
  isRetryableProviderFailure,
  isWeakerJudge,
  materializeCodexAuth,
  parseProviderOrder,
  resolveProviderOrder,
  scrubSecretsFromDir,
} from '../ci-providers.ts';
import { buildJudgeInvocation, runJudge } from '../run-judge.ts';
import { checkCiProviders, formatHealthIssueBody, HEALTH_ISSUE_MARKER } from '../check-ci-providers.ts';
import { parseRealCoachArgs, runWithFallback, summarize } from '../real-coach-check.ts';

const temps: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

describe('CI provider ordering and credentials', () => {
  it('defaults to Codex -> Claude -> OpenCode for Verdict and includes Pi for real Coach', () => {
    expect(resolveProviderOrder('judge', {})).toEqual(DEFAULT_JUDGE_ORDER);
    expect(resolveProviderOrder('coach', {})).toEqual(DEFAULT_COACH_CHECK_ORDER);
  });

  it('respects CI_PROVIDER_ORDER and per-check overrides while ignoring unsupported judge providers', () => {
    expect(resolveProviderOrder('judge', { CI_PROVIDER_ORDER: 'claude, pi, codex, opencode' })).toEqual(['claude', 'codex', 'opencode']);
    expect(resolveProviderOrder('coach', { CI_PROVIDER_ORDER: 'claude, pi, codex, opencode' })).toEqual(['claude', 'pi', 'codex', 'opencode']);
    expect(resolveProviderOrder('judge', { CI_PROVIDER_ORDER: 'claude,codex', JUDGE_PROVIDER: 'opencode' })).toEqual(['opencode']);
    expect(resolveProviderOrder('coach', { CI_PROVIDER_ORDER: 'claude,codex', COACH_CHECK_PROVIDER: 'pi,opencode' })).toEqual(['pi', 'opencode']);
    expect(() => parseProviderOrder('bogus', ['codex', 'claude'], ['codex'])).toThrow(/Unknown CI provider/);
  });

  it('detects configured credentials and flags free OpenCode as a weaker judge', () => {
    expect(hasProviderCredentials('codex', {}, '/nonexistent', () => false)).toEqual({ configured: false });
    expect(hasProviderCredentials('codex', { OPENAI_API_KEY: 'sk-test-1234567890' }, '/nonexistent', () => false)).toEqual({
      configured: true,
      source: 'OPENAI_API_KEY',
    });
    expect(hasProviderCredentials('claude', { ANTHROPIC_API_KEY: 'sk-ant-1234567890' }, '/nonexistent', () => false)).toEqual({
      configured: true,
      source: 'ANTHROPIC_API_KEY',
    });
    expect(hasProviderCredentials('opencode', {}, '/nonexistent', () => false)).toEqual({
      configured: true,
      source: 'opencode-free',
    });
    expect(isWeakerJudge('codex', {})).toBe(false);
    expect(isWeakerJudge('claude', {})).toBe(false);
    expect(isWeakerJudge('opencode', {})).toBe(true);
    expect(isWeakerJudge('opencode', { OPENAI_API_KEY: 'sk-expired' })).toBe(true);
    expect(isWeakerJudge('opencode', { OPENCODE_API_KEY: 'oc-paid-key' })).toBe(false);
  });

  it('decodes raw or base64 CODEX_AUTH_JSON and writes it to CODEX_HOME/auth.json', () => {
    const sample = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-secret-1234567890' } });
    const b64 = Buffer.from(sample, 'utf8').toString('base64');
    expect(JSON.parse(decodeAuthJson(sample))).toEqual(JSON.parse(sample));
    expect(JSON.parse(decodeAuthJson(b64))).toEqual(JSON.parse(sample));
    expect(() => decodeAuthJson('not-json')).toThrow(/not valid JSON/);

    const codexHome = makeTempDir('codex-home-');
    writeFileSync(join(codexHome, 'auth.json'), '{"existing":true}\n', 'utf8');
    const written = materializeCodexAuth({ CODEX_AUTH_JSON: b64, CODEX_HOME: codexHome });
    expect(written?.codexHome).not.toBe(codexHome);
    expect(JSON.parse(readFileSync(written!.path, 'utf8'))).toEqual(JSON.parse(sample));
    written?.restore();
    expect(readFileSync(join(codexHome, 'auth.json'), 'utf8')).toBe('{"existing":true}\n');
  });

  it('classifies auth, quota, and missing-CLI failures as retryable, but not normal failures', () => {
    expect(classifyProviderFailure('HTTP 401 Unauthorized: invalid api key')).toBe('auth');
    expect(classifyProviderFailure('Error: Your credit balance is too low (429)')).toBe('quota');
    expect(classifyProviderFailure('spawn codex ENOENT')).toBe('missing-cli');
    expect(classifyProviderFailure('Test assertion failed: expected PASS')).toBe('other');
    expect(isRetryableProviderFailure('OAuth token expired')).toBe(true);
    expect(isRetryableProviderFailure('The toggle does nothing.')).toBe(false);
  });

  it('scrubs files containing any configured provider secret or nested CODEX_AUTH_JSON token', () => {
    const dir = makeTempDir('scrub-');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const authJson = JSON.stringify({ tokens: { access_token: 'super-secret-codex-access-token' } });
    writeFileSync(join(dir, 'clean.txt'), 'Nothing secret here.\n');
    writeFileSync(join(dir, 'leaked-openai.log'), 'Authorization: Bearer sk-live-openai-secret-9999\n');
    writeFileSync(join(dir, 'nested', 'leaked-codex.log'), 'token=super-secret-codex-access-token\n');

    const removed = scrubSecretsFromDir(dir, {
      OPENAI_API_KEY: 'sk-live-openai-secret-9999',
      CODEX_AUTH_JSON: Buffer.from(authJson).toString('base64'),
    });
    expect(removed.sort()).toEqual([join(dir, 'leaked-openai.log'), join(dir, 'nested', 'leaked-codex.log')].sort());
    expect(readFileSync(join(dir, 'clean.txt'), 'utf8')).toContain('Nothing secret here.');
  });
});

describe('multi-provider judge runner', () => {
  it('builds expected CLI commands for codex, claude, and opencode', () => {
    const out = '/tmp/out';
    expect(buildJudgeInvocation('codex', 'hello', out, {}).command).toBe('codex');
    expect(buildJudgeInvocation('claude', 'hello', out, { CLAUDE_JUDGE_MODEL: 'sonnet' }).args).toContain('sonnet');
    expect(buildJudgeInvocation('opencode', 'hello', out, {}).command).toBe('opencode');
  });

  it('falls back from expired Codex -> skipped Claude -> free OpenCode and marks OpenCode as weaker judge', () => {
    const outDir = makeTempDir('judge-out-');
    const { meta, hasVerdict } = runJudge(
      { prompt: 'judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'codex,claude,opencode', OPENAI_API_KEY: 'sk-expired-key-1234' },
        hasCredentials: (p) => (p === 'claude' ? { configured: false } : { configured: true, source: p }),
        materializeCodex: () => undefined,
        exec: (inv) => {
          if (inv.command === 'codex') {
            return { status: 1, stdout: '', stderr: '401 Unauthorized: invalid_api_key' };
          }
          writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS', summary: 'Looks good.' }));
          writeFileSync(join(outDir, 'verdict.md'), '### What I checked\n\n- everything');
          return { status: 0, stdout: 'done', stderr: '' };
        },
      },
    );

    expect(hasVerdict).toBe(true);
    expect(meta.provider).toBe('opencode');
    expect(meta.weakerJudge).toBe(true);
    expect(meta.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['codex', 'provider-error'],
      ['claude', 'skipped'],
      ['opencode', 'verdict'],
    ]);
  });

  it('never falls back after a valid FAIL verdict', () => {
    const outDir = makeTempDir('judge-fail-');
    const called: string[] = [];
    const { meta, hasVerdict } = runJudge(
      { prompt: 'judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'codex,claude,opencode', OPENAI_API_KEY: 'sk-good-key-1234', ANTHROPIC_API_KEY: 'sk-ant-1234' },
        hasCredentials: () => ({ configured: true }),
        materializeCodex: () => undefined,
        exec: (inv) => {
          called.push(inv.command);
          writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ verdict: 'FAIL', summary: 'Button broken.' }));
          return { status: 0, stdout: 'done', stderr: '' };
        },
      },
    );

    expect(hasVerdict).toBe(true);
    expect(called).toEqual(['codex']);
    expect(meta.provider).toBe('codex');
    expect(meta.weakerJudge).toBe(false);
  });

  it('records allProvidersFailed when every provider fails auth or quota', () => {
    const outDir = makeTempDir('judge-all-fail-');
    const { meta, hasVerdict } = runJudge(
      { prompt: 'judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'codex,opencode', OPENAI_API_KEY: 'sk-expired-1234' },
        hasCredentials: () => ({ configured: true }),
        materializeCodex: () => undefined,
        exec: () => ({ status: 1, stdout: '', stderr: '429 Too Many Requests: rate limit exceeded' }),
      },
    );

    expect(hasVerdict).toBe(false);
    expect(meta.provider).toBeNull();
    expect(meta.allProvidersFailed).toBe(true);
    expect(meta.attempts).toHaveLength(2);
  });
});

describe('real-Coach --provider auto fallback', () => {
  it('parses --provider auto and stamps provider tags into status descriptions', () => {
    expect(parseRealCoachArgs(['--provider', 'auto'])).toEqual({ fake: false, post: false, provider: 'auto', model: 'default' });
    expect(summarize([{ job: 'why', words: 20, maxWords: 150, problems: [], warnings: [] }], 'codex')).toEqual({
      ok: true,
      description: '[codex] 1 Coach call passed the structural checks',
    });
  });

  it('falls back on provider auth errors but stops immediately on structural Coach failures', async () => {
    const tried: string[] = [];
    const verdict = await runWithFallback(
      ['codex', 'claude', 'opencode'],
      async (provider) => {
        tried.push(provider);
        if (provider === 'codex') throw new Error('401 Unauthorized: token expired');
        return { ok: false, sha: 'abc', provider, calls: [], description: '[claude] 1 of 2 Coach calls failed: illegal move' };
      },
      () => true,
    );
    expect(tried).toEqual(['codex', 'claude']);
    expect(verdict.ok).toBe(false);
    expect(verdict.provider).toBe('claude');
  });

  it('falls back when a Coach client throws a structured coach-unavailable error', async () => {
    const tried: string[] = [];
    const verdict = await runWithFallback(
      ['claude', 'opencode'],
      async (provider) => {
        tried.push(provider);
        if (provider === 'claude') {
          const err = Object.assign(new Error('Account on hold'), { code: 'coach-unavailable' });
          throw err;
        }
        return { ok: true, sha: 'abc', provider, calls: [], description: '[opencode] ok' };
      },
      () => true,
    );
    expect(tried).toEqual(['claude', 'opencode']);
    expect(verdict.ok).toBe(true);
    expect(verdict.provider).toBe('opencode');
  });
});

describe('local Claude desktop login and Codex auth restore', () => {
  it('detects ~/.claude login locally but skips it inside GitHub Actions', () => {
    const fakeExists = (p: string) => p.endsWith('/.claude');
    expect(hasProviderCredentials('claude', {}, '/home/dev', fakeExists)).toEqual({
      configured: true,
      source: 'claude-desktop-login',
    });
    expect(hasProviderCredentials('claude', { GITHUB_ACTIONS: 'true' }, '/home/dev', fakeExists)).toEqual({
      configured: false,
    });
  });

  it('writes CODEX_AUTH_JSON to an isolated temp CODEX_HOME and removes it on restore', () => {
    const handle = materializeCodexAuth({ CODEX_AUTH_JSON: '{"tokens":{"access_token":"temp"}}' });
    expect(handle).toBeDefined();
    expect(existsSync(handle!.path)).toBe(true);
    expect(readFileSync(handle!.path, 'utf8')).toContain('temp');
    handle?.restore();
    expect(existsSync(handle!.codexHome)).toBe(false);
  });
});

describe('weekly CI provider health check', () => {
  it('probes only saved provider logins, skips free OpenCode, and formats a plain-English GitHub issue body', () => {
    const probed: string[] = [];
    const results = checkCiProviders({
      env: { OPENAI_API_KEY: 'sk-expired-1234' },
      hasCredentials: (p) => (p === 'claude' ? { configured: false } : { configured: true, source: p === 'codex' ? 'OPENAI_API_KEY' : 'opencode-free' }),
      probe: (p) => {
        probed.push(p);
        return p === 'codex'
          ? { status: 1, stdout: '', stderr: '401 Unauthorized: invalid_api_key' }
          : { status: 0, stdout: 'OK', stderr: '' };
      },
    });

    expect(probed).toEqual(['codex']);
    expect(results.map((r) => [r.provider, r.status])).toEqual([
      ['codex', 'failed'],
      ['claude', 'skipped'],
      ['opencode', 'skipped'],
    ]);

    const body = formatHealthIssueBody(results, 'https://github.com/inprealpha/OpenChessCoach/actions/runs/99');
    expect(body).toContain(HEALTH_ISSUE_MARKER);
    expect(body).toContain('**1** broken provider login');
    expect(body).toContain('Settings → Secrets and variables → Actions → Secrets');
    expect(body).toContain('https://github.com/inprealpha/OpenChessCoach/actions/runs/99');
  });

  it('treats OPENCODE_ZEN_API_KEY as a paid OpenCode key and forwards it to OPENCODE_API_KEY in runJudge', () => {
    expect(isWeakerJudge('opencode', {})).toBe(true);
    expect(isWeakerJudge('opencode', { OPENCODE_API_KEY: 'oc-key' })).toBe(false);
    expect(isWeakerJudge('opencode', { OPENCODE_ZEN_API_KEY: 'zen-key' })).toBe(false);

    const outDir = makeTempDir('judge-zen-');
    let seenKey: string | undefined;
    const { meta, hasVerdict } = runJudge(
      { prompt: 'Judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'opencode', OPENCODE_ZEN_API_KEY: 'zen-secret-123' },
        exec: (_inv, _wd, runEnv) => {
          seenKey = runEnv.OPENCODE_API_KEY;
          writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS', summary: 'Looks good.' }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    expect(hasVerdict).toBe(true);
    expect(seenKey).toBe('zen-secret-123');
    expect(meta.weakerJudge).toBe(false);
  });

  it('probes each saved login independently when a provider has multiple saved secrets', () => {
    const seen: Array<[string, string | undefined, string | undefined]> = [];
    const results = checkCiProviders({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-expired', ANTHROPIC_API_KEY: 'sk-ant-valid' },
      hasCredentials: (p) => (p === 'codex' ? { configured: false } : { configured: true, source: 'opencode-free' }),
      probe: (p, probeEnv) => {
        seen.push([p, probeEnv.CLAUDE_CODE_OAUTH_TOKEN, probeEnv.ANTHROPIC_API_KEY]);
        if (p === 'claude' && probeEnv.CLAUDE_CODE_OAUTH_TOKEN) {
          return { status: 1, stdout: '', stderr: '401 Unauthorized: OAuth token expired' };
        }
        return { status: 0, stdout: 'OK', stderr: '' };
      },
    });

    const claudeResults = results.filter((r) => r.provider === 'claude');
    expect(claudeResults.map((r) => [r.source, r.status])).toEqual([
      ['CLAUDE_CODE_OAUTH_TOKEN', 'failed'],
      ['ANTHROPIC_API_KEY', 'ok'],
    ]);
    expect(seen).toContainEqual(['claude', 'oauth-expired', undefined]);
    expect(seen).toContainEqual(['claude', undefined, 'sk-ant-valid']);
  });
});
