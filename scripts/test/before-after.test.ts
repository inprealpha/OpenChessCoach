import { describe, expect, it } from 'vitest';
import { sideBySideHtml } from '../before-after.ts';

describe('the before and after picture', () => {
  it('labels the before on the left and the after on the right', () => {
    const html = sideBySideHtml('QkVGT1JF', 'QUZURVI=');
    expect(html.indexOf('>Before<')).toBeGreaterThan(-1);
    expect(html.indexOf('>Before<')).toBeLessThan(html.indexOf('>After<'));
    expect(html.indexOf('QkVGT1JF')).toBeLessThan(html.indexOf('QUZURVI='));
  });

  it('shows the after alone for a new screen', () => {
    const html = sideBySideHtml(null, 'QUZURVI=');
    expect(html).not.toContain('>Before<');
    expect(html).toContain('>After<');
  });
});
