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
