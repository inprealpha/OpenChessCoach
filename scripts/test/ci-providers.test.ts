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
  isZdrFreeOpenCodeModel,
  materializeCodexAuth,
  parseProviderOrder,
  resolveProviderOrder,
  resolveZdrFreeOpenCodeModels,
  scrubSecretsFromDir,
  ZDR_FREE_OPENCODE_MODELS,
} from '../ci-providers.ts';
import {
  buildJudgeInvocation,
  buildOpenCodeJudgePermission,
  detectFatalProviderErrorLine,
  execJudgeProcess,
  isOpenCodeStartupOrLogLine,
  runJudge,
} from '../run-judge.ts';
import { checkCiProviders, formatHealthIssueBody, HEALTH_ISSUE_MARKER } from '../check-ci-providers.ts';
import { parseRealCoachArgs, resolveOpenCodeModelsToTry, runWithFallback, summarize } from '../real-coach-check.ts';

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
    const opencodeInv = buildJudgeInvocation('opencode', 'hello', out, {});
    expect(opencodeInv.command).toBe('opencode');
    expect(opencodeInv.args).toContain('--print-logs');
    expect(opencodeInv.args).toContain('--log-level');
    expect(opencodeInv.args).toContain('ERROR');
  });

  it('falls back from expired Codex -> skipped Claude -> free OpenCode and marks OpenCode as weaker judge', async () => {
    const outDir = makeTempDir('judge-out-');
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'codex,claude,opencode', OPENAI_API_KEY: 'sk-expired-key-1234' },
        hasCredentials: (p) => (p === 'claude' ? { configured: false } : { configured: true, source: p }),
        materializeCodex: () => undefined,
        log: () => {},
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

  it('never falls back after a valid FAIL verdict', async () => {
    const outDir = makeTempDir('judge-fail-');
    const called: string[] = [];
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'codex,claude,opencode', OPENAI_API_KEY: 'sk-good-key-1234', ANTHROPIC_API_KEY: 'sk-ant-1234' },
        hasCredentials: () => ({ configured: true }),
        materializeCodex: () => undefined,
        log: () => {},
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

  it('records allProvidersFailed when every provider fails auth or quota', async () => {
    const outDir = makeTempDir('judge-all-fail-');
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'codex,opencode', OPENAI_API_KEY: 'sk-expired-1234' },
        hasCredentials: () => ({ configured: true }),
        materializeCodex: () => undefined,
        log: () => {},
        exec: () => ({ status: 1, stdout: '', stderr: '429 Too Many Requests: rate limit exceeded' }),
      },
    );

    expect(hasVerdict).toBe(false);
    expect(meta.provider).toBeNull();
    expect(meta.allProvidersFailed).toBe(true);
    expect(meta.attempts).toHaveLength(1 + ZDR_FREE_OPENCODE_MODELS.length);
  });

  it('passes narrow OPENCODE_PERMISSION allowing only judge input/output/base dirs', async () => {
    const workspace = makeTempDir('judge-perm-ws-');
    const inDir = join(workspace, 'verdict-in');
    const outDir = join(workspace, 'verdict-out');
    const baseDir = join(workspace, 'base');
    mkdirSync(inDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });

    const seenEnv: NodeJS.ProcessEnv[] = [];
    const { hasVerdict } = await runJudge(
      { prompt: 'judge this PR', outDir, workdir: workspace, inDir },
      {
        env: { CI_PROVIDER_ORDER: 'opencode', GITHUB_WORKSPACE: workspace },
        hasCredentials: () => ({ configured: true, source: 'opencode-free' }),
        log: () => {},
        exec: (_inv, _workdir, env) => {
          seenEnv.push(env);
          writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS', summary: 'Looks good.' }));
          return { status: 0, stdout: 'done', stderr: '' };
        },
      },
    );

    expect(hasVerdict).toBe(true);
    expect(seenEnv).toHaveLength(1);
    const parsed = JSON.parse(seenEnv[0]?.OPENCODE_PERMISSION ?? '{}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['external_directory']);
    const ext = parsed.external_directory as Record<string, string>;
    expect(Object.keys(ext)[0]).toBe('*');
    expect(ext['*']).toBe('deny');
    expect(ext[outDir.replace(/\\/g, '/')]).toBe('allow');
    expect(ext[`${outDir.replace(/\\/g, '/')}/*`]).toBe('allow');
    expect(ext[inDir.replace(/\\/g, '/')]).toBe('allow');
    expect(ext[`${inDir.replace(/\\/g, '/')}/*`]).toBe('allow');
    expect(ext[baseDir.replace(/\\/g, '/')]).toBe('allow');
    expect(ext[`${baseDir.replace(/\\/g, '/')}/*`]).toBe('allow');

    const explicit = buildOpenCodeJudgePermission([inDir]);
    expect(JSON.parse(explicit)).toEqual({
      external_directory: {
        '*': 'deny',
        [inDir.replace(/\\/g, '/')]: 'allow',
        [`${inDir.replace(/\\/g, '/')}/*`]: 'allow',
      },
    });
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

  it('treats OPENCODE_ZEN_API_KEY as a paid OpenCode key and forwards it to OPENCODE_API_KEY in runJudge', async () => {
    expect(isWeakerJudge('opencode', {})).toBe(true);
    expect(isWeakerJudge('opencode', { OPENCODE_API_KEY: 'oc-key' })).toBe(false);
    expect(isWeakerJudge('opencode', { OPENCODE_ZEN_API_KEY: 'zen-key' })).toBe(false);

    const outDir = makeTempDir('judge-zen-');
    let seenKey: string | undefined;
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'Judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'opencode', OPENCODE_ZEN_API_KEY: 'zen-secret-123' },
        log: () => {},
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

  it('pins free OpenCode Verdict and real Coach strictly to Zero-Data-Retention models and rejects non-ZDR models', async () => {
    expect(resolveZdrFreeOpenCodeModels({})).toEqual([...ZDR_FREE_OPENCODE_MODELS]);
    expect(resolveZdrFreeOpenCodeModels({ OPENCODE_ZDR_FREE_MODELS: '' })).toEqual([...ZDR_FREE_OPENCODE_MODELS]);
    expect(isZdrFreeOpenCodeModel('opencode/deepseek-v4.1-flash-free', {})).toBe(true);
    expect(isZdrFreeOpenCodeModel('opencode/big-pickle', {})).toBe(false);
    expect(resolveZdrFreeOpenCodeModels({ OPENCODE_ZDR_FREE_MODELS: 'none' })).toEqual([]);

    // real Coach free OpenCode uses ZDR allowlist by default and rejects non-ZDR explicit models.
    expect(resolveOpenCodeModelsToTry('default', {})).toEqual([...ZDR_FREE_OPENCODE_MODELS]);
    expect(() => resolveOpenCodeModelsToTry('opencode/big-pickle', {})).toThrow(/Zero-Data-Retention/i);
    // Paid OpenCode keys and saved local OpenCode logins bypass the free ZDR allowlist restriction.
    expect(resolveOpenCodeModelsToTry('opencode/big-pickle', { OPENCODE_API_KEY: 'paid-key' })).toEqual([
      'opencode/big-pickle',
    ]);
    expect(
      resolveOpenCodeModelsToTry('anthropic/claude-haiku-4-5', {}, '/home/dev', (p) =>
        p.endsWith('/.local/share/opencode/auth.json'),
      ),
    ).toEqual(['anthropic/claude-haiku-4-5']);
    const emptyAuthHome = makeTempDir('opencode-empty-auth-');
    mkdirSync(join(emptyAuthHome, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(emptyAuthHome, '.local', 'share', 'opencode', 'auth.json'), '{}', 'utf8');
    expect(isWeakerJudge('opencode', {}, emptyAuthHome)).toBe(true);
    expect(() =>
      resolveOpenCodeModelsToTry('opencode/big-pickle', { OPENCODE_ZDR_FREE_MODELS: 'none' }, emptyAuthHome),
    ).toThrow(/Zero-Data-Retention/i);
    expect(() =>
      resolveOpenCodeModelsToTry(
        'anthropic/claude-haiku-4-5',
        { GITHUB_ACTIONS: 'true' },
        '/home/dev',
        (p) => p.endsWith('/.local/share/opencode/auth.json'),
      ),
    ).toThrow(/Zero-Data-Retention/i);

    // runJudge tries ZDR free models in order and never defaults to big-pickle.
    const outDir = makeTempDir('judge-zdr-');
    const triedModels: Array<string | undefined> = [];
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'Judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'opencode' },
        log: () => {},
        exec: (inv) => {
          triedModels.push(inv.model);
          if (inv.model === ZDR_FREE_OPENCODE_MODELS[0]) {
            return { status: 1, stdout: '', stderr: '429 rate limit exceeded' };
          }
          writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS', summary: 'ZDR pass.' }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(hasVerdict).toBe(true);
    expect(triedModels).toEqual([ZDR_FREE_OPENCODE_MODELS[0], ZDR_FREE_OPENCODE_MODELS[1]]);
    expect(meta.model).toBe(ZDR_FREE_OPENCODE_MODELS[1]);
    expect(meta.weakerJudge).toBe(true);

    // runJudge refuses a non-ZDR OPENCODE_JUDGE_MODEL when running unauthenticated free OpenCode.
    const outDir2 = makeTempDir('judge-non-zdr-');
    const called: string[] = [];
    const res2 = await runJudge(
      { prompt: 'Judge this PR', outDir: outDir2, workdir: outDir2 },
      {
        env: { CI_PROVIDER_ORDER: 'opencode', OPENCODE_JUDGE_MODEL: 'opencode/big-pickle' },
        log: () => {},
        exec: (inv) => {
          called.push(inv.command);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(res2.hasVerdict).toBe(false);
    expect(res2.meta.allProvidersFailed).toBe(true);
    expect(called).toEqual([]);
  });
});

describe('judge hang and fatal-error watchdogs', () => {
  it('distinguishes OpenCode startup banners and log lines from real model activity and fatal stream errors', () => {
    expect(isOpenCodeStartupOrLogLine('\u001b[0m> build · deepseek-v4.1-flash-free\u001b[0m')).toBe(true);
    expect(isOpenCodeStartupOrLogLine('timestamp=2026-11-22T14:09:58Z level=INFO run=1 message=init')).toBe(true);
    expect(isOpenCodeStartupOrLogLine('$ npm test')).toBe(false);
    expect(isOpenCodeStartupOrLogLine('PASS')).toBe(false);

    const fatalLine =
      'timestamp=2026-11-22T14:09:59.090Z level=ERROR run=554116e2 message="stream error" providerID=opencode modelID=deepseek-v4.1-flash-free error.error="AI_APICallError: Free usage limit reached."';
    expect(detectFatalProviderErrorLine(fatalLine)).toBe('AI_APICallError: Free usage limit reached.');
    // Normal test/diff output quoting Free usage limit reached must never trigger the abort.
    expect(detectFatalProviderErrorLine('✓ classifies 401 Unauthorized and 429 rate limit exceeded')).toBeUndefined();
    expect(detectFatalProviderErrorLine('const msg = "AI_APICallError: Free usage limit reached.";')).toBeUndefined();
  });

  it('does not abort a healthy opencode judge whose stdout quotes Free usage limit reached', async () => {
    const outDir = makeTempDir('judge-quoted-error-');
    const res = await execJudgeProcess(
      {
        provider: 'opencode',
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdout.write(\'timestamp=2026-11-22T14:09:59Z level=ERROR run=1 message="stream error" error.error="AI_APICallError: Free usage limit reached."\\n\');',
            'setTimeout(() => { process.stdout.write("done\\n"); process.exit(0); }, 250);',
          ].join(' '),
        ],
        model: 'opencode/deepseek-v4.1-flash-free',
        logFile: join(outDir, 'judge-opencode.log'),
      },
      outDir,
      process.env,
      { firstActivityMs: 2_000, idleMs: 2_000, overallMs: 5_000, fatalErrorGraceMs: 50, killGraceMs: 100 },
    );

    expect(res.status).toBe(0);
    expect(res.abortedProviderError).toBeUndefined();
    expect(res.timedOut).toBeUndefined();
  });

  it('aborts a hung opencode process promptly after Free usage limit reached instead of hanging', async () => {
    const outDir = makeTempDir('judge-hang-limit-');
    const start = Date.now();
    const res = await execJudgeProcess(
      {
        provider: 'opencode',
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stderr.write("> build · deepseek-v4.1-flash-free\\n");',
            'process.stderr.write(\'timestamp=2026-11-22T14:09:59Z level=ERROR run=1 message="stream error" error.error="AI_APICallError: Free usage limit reached."\\n\');',
            'setInterval(() => {}, 60_000);',
          ].join(' '),
        ],
        model: 'opencode/deepseek-v4.1-flash-free',
        logFile: join(outDir, 'judge-opencode.log'),
      },
      outDir,
      process.env,
      { firstActivityMs: 5_000, idleMs: 5_000, overallMs: 10_000, fatalErrorGraceMs: 150, killGraceMs: 200 },
    );

    expect(Date.now() - start).toBeLessThan(3_000);
    expect(res.abortedProviderError).toContain('Free usage limit reached');
    expect(res.timedOut).toBeUndefined();
  });

  it('aborts a silent opencode process that prints only its startup banner and never answers', async () => {
    const outDir = makeTempDir('judge-hang-silent-');
    const start = Date.now();
    const res = await execJudgeProcess(
      {
        provider: 'opencode',
        command: process.execPath,
        args: ['-e', 'process.stderr.write("> build · deepseek-v4.1-flash-free\\n"); setInterval(() => {}, 60_000);'],
        model: 'opencode/deepseek-v4.1-flash-free',
        logFile: join(outDir, 'judge-opencode.log'),
      },
      outDir,
      process.env,
      { firstActivityMs: 250, idleMs: 5_000, overallMs: 10_000, killGraceMs: 200 },
    );

    expect(Date.now() - start).toBeLessThan(3_000);
    expect(res.timedOut).toBe('first-activity');
  });

  it('aborts a judge process that stalls mid-run after producing initial activity', async () => {
    const outDir = makeTempDir('judge-hang-idle-');
    const start = Date.now();
    const res = await execJudgeProcess(
      {
        provider: 'opencode',
        command: process.execPath,
        args: ['-e', 'process.stderr.write("$ npm test\\n"); setInterval(() => {}, 60_000);'],
        model: 'opencode/deepseek-v4.1-flash-free',
        logFile: join(outDir, 'judge-opencode.log'),
      },
      outDir,
      process.env,
      { firstActivityMs: 2_000, idleMs: 250, overallMs: 10_000, killGraceMs: 200 },
    );

    expect(Date.now() - start).toBeLessThan(3_000);
    expect(res.timedOut).toBe('idle');
  });

  it('counts non-newline-terminated opencode token streams as activity so active streams do not time out', async () => {
    const outDir = makeTempDir('judge-stream-tokens-');
    const res = await execJudgeProcess(
      {
        provider: 'opencode',
        command: process.execPath,
        args: [
          '-e',
          'let n = 0; const t = setInterval(() => { process.stdout.write("tok "); if (++n >= 6) { clearInterval(t); process.exit(0); } }, 80);',
        ],
        model: 'opencode/deepseek-v4.1-flash-free',
        logFile: join(outDir, 'judge-opencode.log'),
      },
      outDir,
      process.env,
      { firstActivityMs: 200, idleMs: 200, overallMs: 5_000, killGraceMs: 100 },
    );

    expect(res.status).toBe(0);
    expect(res.timedOut).toBeUndefined();
    expect(res.stdout).toContain('tok ');
  });

  it('kills SIGTERM-resistant descendants in the process group when a timed-out judge exits early', async () => {
    if (process.platform === 'win32') return;
    const outDir = makeTempDir('judge-descendant-kill-');
    const pidFile = join(outDir, 'grandchild.pid');
    const res = await execJudgeProcess(
      {
        provider: 'opencode',
        command: process.execPath,
        args: [
          '-e',
          [
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            'const gc = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 60000);"], { stdio: "ignore" });',
            `writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
            'setInterval(() => {}, 60000);',
          ].join(' '),
        ],
        model: 'opencode/deepseek-v4.1-flash-free',
        logFile: join(outDir, 'judge-opencode.log'),
      },
      outDir,
      process.env,
      { firstActivityMs: 250, idleMs: 5_000, overallMs: 5_000, killGraceMs: 2_000 },
    );

    expect(res.timedOut).toBe('first-activity');
    const gcPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(gcPid) && gcPid > 0).toBe(true);
    // Give the OS a brief moment to reap the SIGKILLed grandchild.
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(gcPid, 0)).toThrow();
  });

  it('advances to the next ZDR free model when the first hangs on Free usage limit reached or times out', async () => {
    const outDir = makeTempDir('judge-fallback-hang-');
    const tried: Array<string | undefined> = [];
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'Judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'opencode' },
        log: () => {},
        exec: (inv) => {
          tried.push(inv.model);
          if (inv.model === ZDR_FREE_OPENCODE_MODELS[0]) {
            return {
              status: null,
              stdout: '',
              stderr: 'level=ERROR message="stream error" error.error="AI_APICallError: Free usage limit reached."',
              abortedProviderError: 'level=ERROR message="stream error" error.error="AI_APICallError: Free usage limit reached."',
            };
          }
          if (inv.model === ZDR_FREE_OPENCODE_MODELS[1]) {
            return { status: null, stdout: '', stderr: '> build · hy4-flash-free\n', timedOut: 'first-activity' };
          }
          writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS', summary: 'Third ZDR model answered.' }));
          return { status: 0, stdout: 'done', stderr: '' };
        },
      },
    );

    expect(hasVerdict).toBe(true);
    expect(tried).toEqual([...ZDR_FREE_OPENCODE_MODELS]);
    expect(meta.model).toBe(ZDR_FREE_OPENCODE_MODELS[2]);
    expect(meta.attempts).toMatchObject([
      { provider: 'opencode', model: ZDR_FREE_OPENCODE_MODELS[0], outcome: 'provider-error', failureKind: 'quota' },
      { provider: 'opencode', model: ZDR_FREE_OPENCODE_MODELS[1], outcome: 'provider-error', failureKind: 'timeout' },
      { provider: 'opencode', model: ZDR_FREE_OPENCODE_MODELS[2], outcome: 'verdict' },
    ]);
  });

  it('exits with allProvidersFailed and writes judge-meta.json when every ZDR free model gets no answer', async () => {
    const outDir = makeTempDir('judge-all-hang-');
    const { meta, hasVerdict } = await runJudge(
      { prompt: 'Judge this PR', outDir, workdir: outDir },
      {
        env: { CI_PROVIDER_ORDER: 'opencode' },
        log: () => {},
        exec: () => ({ status: null, stdout: '', stderr: '', timedOut: 'first-activity' }),
      },
    );

    expect(hasVerdict).toBe(false);
    expect(meta.allProvidersFailed).toBe(true);
    expect(meta.attempts).toHaveLength(ZDR_FREE_OPENCODE_MODELS.length);
    expect(meta.attempts.every((a) => a.failureKind === 'timeout' && a.reason?.includes('No answer'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(outDir, 'judge-meta.json'), 'utf8')) as typeof meta;
    expect(saved.allProvidersFailed).toBe(true);
    expect(saved.attempts).toHaveLength(ZDR_FREE_OPENCODE_MODELS.length);
  });
});
