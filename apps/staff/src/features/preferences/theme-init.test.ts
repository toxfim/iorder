import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveToken } from '@core/test-utils/token-css';
import { THEME_STORAGE_KEY } from './theme';

// theme-init.js (shared public file of both apps, packages/web-core/public) is a classic script
// that runs before the app; evaluate it as the browser would.
const source = readFileSync(
  resolve(process.cwd(), '../../packages/web-core/public/theme-init.js'),
  'utf8',
);
const run = (): void => {
  new Function(source)();
};
const root = document.documentElement;

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  root.removeAttribute('data-theme');
  document.head.innerHTML =
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#10141a" media="(prefers-color-scheme: dark)">';
});

describe('theme-init.js', () => {
  it('uses the same storage key as the app', () => {
    expect(source).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('pins the stored explicit choice and the browser chrome colour', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    run();
    expect(root.getAttribute('data-theme')).toBe('dark');
    const contents = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) =>
      m.getAttribute('content'),
    );
    expect(contents).toEqual([resolveToken('dark', '--page'), resolveToken('dark', '--page')]);
  });

  it('does nothing for system, a missing value or a bad value', () => {
    run();
    expect(root.hasAttribute('data-theme')).toBe(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    run();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    run();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(run).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps its page colours equal to the --page token of each theme', () => {
    expect(source).toContain(`'${resolveToken('light', '--page')}'`);
    expect(source).toContain(`'${resolveToken('dark', '--page')}'`);
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain(
      `content="${resolveToken('light', '--page')}" media="(prefers-color-scheme: light)"`,
    );
    expect(html).toContain(
      `content="${resolveToken('dark', '--page')}" media="(prefers-color-scheme: dark)"`,
    );
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html).toContain('name="color-scheme" content="light dark"');
  });
});
