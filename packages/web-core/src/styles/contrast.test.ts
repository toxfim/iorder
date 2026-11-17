import { describe, expect, it } from 'vitest';
import { contrastRatio, resolveToken, type Theme } from '@core/test-utils/token-css';

// WCAG 2.x ratios computed from the token values. Normal text needs 4.5, icons, focus rings
// and status dots 3. The pairs are data so a new token pair is one line.
// Numbers in docs/private/design/dark-mode-plan.md (appendix A) come from this same arithmetic.

const TEXT = 4.5;
const ICON = 3;

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
}

const surfaces = ['--page', '--f5', '--ef', '--w'] as const;

const pairs: Pair[] = [
  ...surfaces.flatMap((bg) => [
    { fg: '--ink', bg, min: TEXT },
    { fg: '--t2', bg, min: TEXT },
    { fg: '--t3', bg, min: TEXT },
    { fg: '--b5', bg, min: ICON },
    { fg: '--red', bg, min: TEXT },
    { fg: '--green', bg, min: TEXT },
    { fg: '--amber', bg, min: TEXT },
  ]),
  { fg: '--ink', bg: '--beige', min: TEXT },
  { fg: '--t2', bg: '--beige', min: TEXT },
  { fg: '--on-ink', bg: '--ink', min: TEXT },
  { fg: '--hero-fg', bg: '--hero-bg', min: TEXT },
  { fg: '--hero-muted', bg: '--hero-bg', min: TEXT },
  { fg: '--btn-ink-fg', bg: '--btn-ink-bg', min: TEXT },
  { fg: '--btn-ink-muted', bg: '--btn-ink-bg', min: TEXT },
  { fg: '--acc-on-dark', bg: '--btn-ink-bg', min: TEXT },
  { fg: '--acc-on', bg: '--acc', min: TEXT },
  { fg: '--acc-on', bg: '--acc-hover', min: TEXT },
  { fg: '--acc-fg', bg: '--acc-bg', min: TEXT },
  { fg: '--acc-fg', bg: '--acc-bg2', min: TEXT },
  { fg: '--acc-fg', bg: '--w', min: TEXT },
  { fg: '--acc-on-dark', bg: '--ink', min: TEXT },
  { fg: '--red', bg: '--red-bg', min: TEXT },
  { fg: '--green', bg: '--green-bg', min: TEXT },
  { fg: '--amber', bg: '--amber-bg', min: TEXT },
  { fg: '--warn', bg: '--w', min: ICON },
  { fg: '--acc', bg: '--w', min: ICON },
  { fg: '--acc', bg: '--page', min: ICON },
  { fg: '--stage-4', bg: '--w', min: ICON },
  { fg: '--stage-5', bg: '--w', min: ICON },
  { fg: '--acc-fg', bg: '--selection-bg', min: TEXT },
];

// Known failures, recorded with the measured floor so they cannot get worse. Every entry is
// decorative (hairlines, strokes) or a focus ring on the grey containers; see the appendix.
const KNOWN: Readonly<Record<Theme, readonly Pair[]>> = {
  light: [
    { fg: '--acc', bg: '--ef', min: 2.6 },
    { fg: '--acc', bg: '--f5', min: 2.8 },
    { fg: '--e8', bg: '--w', min: 1.2 },
    { fg: '--d9', bg: '--w', min: 1.4 },
  ],
  dark: [
    { fg: '--e8', bg: '--w', min: 1.5 },
    { fg: '--d9', bg: '--w', min: 1.8 },
  ],
};

function ratio(theme: Theme, pair: Pair): number {
  return contrastRatio(resolveToken(theme, pair.fg), resolveToken(theme, pair.bg));
}

describe.each<Theme>(['light', 'dark'])('contrast in the %s theme', (theme) => {
  it.each(pairs.map((pair) => [`${pair.fg} on ${pair.bg}`, pair] as const))(
    '%s reaches its target',
    (_label, pair) => {
      expect(ratio(theme, pair)).toBeGreaterThanOrEqual(pair.min);
    },
  );

  it.each(KNOWN[theme].map((pair) => [`${pair.fg} on ${pair.bg}`, pair] as const))(
    'known exception %s does not get worse',
    (_label, pair) => {
      expect(ratio(theme, pair)).toBeGreaterThanOrEqual(pair.min);
    },
  );
});
