// The Verdict's status and comment (ADR 0013): only a well-formed PASS passes, and a judge that
// gave no verdict posts an error, never a pass.
import { describe, expect, it } from 'vitest';
import { clip, COMMENT_MARKER, commentFor, parseVerdict, skippedStatus, statusFor } from '../verdict.ts';

const SHA = 'a'.repeat(40);
const RUN = 'https://github.com/inprealpha/OpenChessCoach/actions/runs/1';

describe('the Verdict status', () => {
  it('passes on PASS and PASS+NOTES, fails on FAIL', () => {
    expect(statusFor(parseVerdict('{"verdict":"PASS","summary":"The overview streams first."}'))).toEqual({ state: 'success', description: 'PASS: The overview streams first.' });
    expect(statusFor(parseVerdict('{"verdict":"PASS+NOTES","summary":"Works; one note."}')).state).toBe('success');
    expect(statusFor(parseVerdict('{"verdict":"FAIL","summary":"The toggle does nothing."}'))).toEqual({ state: 'failure', description: 'FAIL: The toggle does nothing.' });
  });

  it('posts an error when there is no verdict, or a malformed one', () => {
    for (const text of [undefined, '', 'not json', '{"verdict":"pass","summary":"x"}', '{"verdict":"PASS"}', '{"verdict":"PASS","summary":"  "}', '{"verdict":"MAYBE","summary":"x"}']) {
      expect(statusFor(parseVerdict(text)).state).toBe('error');
    }
  });

  it('keeps the description within the 140 characters GitHub keeps', () => {
    const { description } = statusFor(parseVerdict(JSON.stringify({ verdict: 'FAIL', summary: 'word '.repeat(60) })));
    expect(description.length).toBe(140);
    expect(description.endsWith('…')).toBe(true);
    expect(clip('a\n\n b')).toBe('a b');
  });
});

describe('the Verdict comment', () => {
  it('starts with the marker and names the commit and the run', () => {
    const comment = commentFor(parseVerdict('{"verdict":"FAIL","summary":"Broken."}'), '### What I checked\n\n- the Review', SHA, RUN);
    expect(comment.startsWith(`${COMMENT_MARKER} sha=${SHA} -->`)).toBe(true);
    expect(comment).toContain('## Verdict: FAIL');
    expect(comment).toContain(`For commit ${SHA}`);
    expect(comment).toContain('### What I checked');
    expect(comment).toContain(RUN);
  });

  it('says there is no verdict, and leaves out a write-up that came without one', () => {
    const comment = commentFor(undefined, 'PASS, trust me', SHA, RUN);
    expect(comment).toContain('## Verdict: none');
    expect(comment).not.toContain('trust me');
  });
});

describe('a run that never started the judge', () => {
  it('says setup failed, and its comment carries no marker, so it uses none of the limits', () => {
    expect(statusFor(undefined, false)).toEqual({ state: 'error', description: "The judge didn't start (setting up the app failed): comment /verdict to try again" });
    const comment = commentFor(undefined, undefined, SHA, RUN, false);
    expect(comment).not.toContain(COMMENT_MARKER);
    expect(comment).toContain('## Verdict: none');
    expect(comment).toContain("The judge didn't start");
  });
});

describe('a run skipped because the PR changed while the gate waited', () => {
  it('posts its reason as an error, never a pass', () => {
    expect(skippedStatus('The PR was closed before the judge started\n')).toEqual({ state: 'error', description: 'The PR was closed before the judge started' });
    expect(skippedStatus(undefined)).toBeUndefined();
    expect(skippedStatus('  ')).toBeUndefined();
  });
});

describe('multi-provider and local-fallback metadata', () => {
  it('labels free OpenCode runs as a weaker judge in both the status and PR comment', () => {
    const meta = {
      provider: 'opencode' as const,
      weakerJudge: true,
      source: 'ci' as const,
      attempts: [
        { provider: 'codex' as const, outcome: 'skipped' as const, reason: 'no credentials configured' },
        { provider: 'opencode' as const, outcome: 'verdict' as const, exitCode: 0 },
      ],
    };
    const verdict = parseVerdict('{"verdict":"PASS","summary":"Looks good."}');
    expect(statusFor(verdict, true, meta)).toEqual({ state: 'success', description: 'PASS: [weaker judge: opencode] Looks good.' });
    const comment = commentFor(verdict, '### What I checked\n\n- board', SHA, RUN, true, meta);
    expect(comment).toContain('Weaker judge notice');
    expect(comment).toContain('weaker free fallback');
  });

  it('labels local independent-agent fallback runs and lists failed CI providers when all fail', () => {
    const localMeta = { provider: null, weakerJudge: false, source: 'local' as const, judgeAgent: 'Devin-Reviewer', attempts: [] };
    const verdict = parseVerdict('{"verdict":"PASS","summary":"Verified locally."}');
    expect(statusFor(verdict, true, localMeta)).toEqual({ state: 'success', description: 'PASS: [local: Devin-Reviewer] Verified locally.' });
    const localComment = commentFor(verdict, '### What I checked\n\n- all tests', SHA, undefined, true, localMeta);
    expect(localComment).toContain('Local independent fallback');
    expect(localComment).toContain('Devin-Reviewer');
    expect(localComment).not.toContain('verdict-evidence');

    const failedMeta = {
      provider: null,
      weakerJudge: false,
      source: 'ci' as const,
      allProvidersFailed: true,
      attempts: [{ provider: 'codex' as const, outcome: 'provider-error' as const, reason: '401 Unauthorized' }],
    };
    expect(statusFor(undefined, true, failedMeta).description).toContain('No CI judge available');
    const failedComment = commentFor(undefined, undefined, SHA, RUN, true, failedMeta);
    expect(failedComment).toContain('CI providers tried');
    expect(failedComment).toContain('401 Unauthorized');
    expect(failedComment).toContain('--local --judge-agent');
  });
});
