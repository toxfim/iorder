import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaveTo, setPageLeaver } from './leave-page';

describe('leaving the app for another site', () => {
  afterEach(() => setPageLeaver());

  it('goes to an http(s) address', () => {
    const leaver = vi.fn();
    setPageLeaver(leaver);
    expect(leaveTo('https://order.iorder.uz/#handoff=abc')).toBe(true);
    expect(leaveTo('http://localhost:5174/')).toBe(true);
    expect(leaver.mock.calls).toEqual([
      ['https://order.iorder.uz/#handoff=abc'],
      ['http://localhost:5174/'],
    ]);
  });

  it('refuses everything that is not a full http(s) address', () => {
    const leaver = vi.fn();
    setPageLeaver(leaver);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      '//evil.example',
      '/handoff',
      'ftp://files.example',
      '',
      'not a url',
    ]) {
      expect(leaveTo(bad), bad).toBe(false);
    }
    expect(leaver).not.toHaveBeenCalled();
  });
});
