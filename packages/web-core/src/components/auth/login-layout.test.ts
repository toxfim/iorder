import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Fixed minimum panel heights caused the normal login to overflow laptop viewports.
describe('responsive login height regression', () => {
  const css = readFileSync('src/components/auth/login.css', 'utf8');
  it('lets panels fit their content instead of forcing reference-frame heights', () => {
    expect(css).not.toMatch(/min-height:\s*(720|790)px/);
    expect(css).toContain('@media (max-height: 850px)');
  });
  it('keeps overflow reachable on small screens and when help or errors expand', () => {
    const page = css.match(/\.auth-page\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(page).not.toMatch(/(?:overflow(?:-y)?):\s*hidden/);
    expect(css).toContain('min-height: 100dvh');
  });
});
