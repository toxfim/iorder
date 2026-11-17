import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  TOKENS_FILE,
  listFrontendFiles,
  repoRelative as rel,
} from '@core/test-utils/frontend-sources';

// Dark-mode audit (docs/private/design/dark-mode-plan.md, slice 4). A source scan, no browser:
// 1. `--ink` flips to a light colour in dark, so it must never be a fill. Small ink fills use
//    --btn-ink-bg/--btn-ink-fg, large blocks use --hero-bg/--hero-fg.
// 2. Fractional opacity is a colour trick whose contrast no token controls, so dimming goes
//    through colour tokens. A use that is really needed is listed below with its reason.

// file (relative to the repository root, forward slashes) -> reason it may use a fractional opacity.
// Empty on purpose: every dimming site was replaced by a token (slice 4).
const FRACTIONAL_OPACITY_ALLOWED: Readonly<Record<string, string>> = {};

function styleText(file: string): string {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  if (file.endsWith('.css')) return source;
  const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
  const inline = [...source.matchAll(/style="([^"]*)"|:style="([^"]*)"/g)].map(
    (m) => m[1] ?? m[2] ?? '',
  );
  return [...blocks, ...inline].join('\n');
}

describe('dark mode audit', () => {
  const files = listFrontendFiles((name) => /\.(vue|css)$/.test(name)).filter(
    (file) => rel(file) !== TOKENS_FILE,
  );

  it('scans the sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never uses --ink as a background', () => {
    const offenders = files
      .filter((file) => /background(?:-color)?\s*:[^;{}]*var\(--ink\)/.test(styleText(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('never pairs --on-ink with a fill other than through the btn-ink and hero tokens', () => {
    const offenders = files.filter((file) => /var\(--on-ink\)/.test(styleText(file))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('has no fractional opacity outside the allow-list', () => {
    const fractional = /(?<![-\w])(?:fill-|stroke-)?opacity\s*:\s*(?:0?\.\d+|\d+%)/;
    const offenders = files
      .filter((file) => fractional.test(styleText(file)))
      .map(rel)
      .filter((file) => !(file in FRACTIONAL_OPACITY_ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('keeps every allow-list entry justified and still needed', () => {
    for (const [file, reason] of Object.entries(FRACTIONAL_OPACITY_ALLOWED)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(files.map(rel)).toContain(file);
    }
  });

  it('swaps the logo with the theme in both dark conditions', () => {
    const base = readFileSync(join(REPO_ROOT, 'packages/web-core/src/styles/base.css'), 'utf8');
    expect(base).toContain(":root[data-theme='dark'] .logo__img--dark");
    expect(base).toContain(":root:not([data-theme='light']) .logo__img--dark");
  });
});
