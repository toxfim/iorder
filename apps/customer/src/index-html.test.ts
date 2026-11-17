import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveToken } from '@core/test-utils/token-css';

// The page shell must set the theme before the first paint, as the staff app does: the shared
// theme-init.js (packages/web-core/public) and theme colours equal to the --page token.
describe('index.html', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it('loads the shared theme script before the app', () => {
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/main.ts'));
    expect(html).toContain('name="color-scheme" content="light dark"');
  });

  it('keeps its theme colours equal to the --page token of each theme', () => {
    expect(html).toContain(
      `content="${resolveToken('light', '--page')}" media="(prefers-color-scheme: light)"`,
    );
    expect(html).toContain(
      `content="${resolveToken('dark', '--page')}" media="(prefers-color-scheme: dark)"`,
    );
  });
});
