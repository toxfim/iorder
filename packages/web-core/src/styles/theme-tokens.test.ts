import { describe, expect, it } from 'vitest';
import {
  colourTokenNames,
  darkExplicitDeclarations,
  darkMediaDeclarations,
  lightDeclarations,
} from '@core/test-utils/token-css';

// Tokens that are deliberately the same in both themes. Empty on purpose: "forgot" and "same
// on purpose" must be told apart, so an unchanged value has to be listed here with a reason.
const SHARED_ON_PURPOSE: readonly string[] = [];

describe('theme token parity', () => {
  const names = colourTokenNames();

  it('finds the colour tokens of the light theme', () => {
    expect(names.length).toBeGreaterThan(40);
    expect(names).toContain('--hero-bg');
    expect(names).toContain('--selection-bg');
  });

  it('gives every colour token a dark value', () => {
    const missing = names.filter(
      (name) => !darkExplicitDeclarations.has(name) && !SHARED_ON_PURPOSE.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('does not declare dark values for tokens that do not exist in light', () => {
    const extra = [...darkExplicitDeclarations.keys()].filter(
      (name) => name !== 'color-scheme' && !lightDeclarations.has(name),
    );
    expect(extra).toEqual([]);
  });

  it('declares color-scheme in light and in both dark blocks', () => {
    expect(lightDeclarations.get('color-scheme')).toBe('light');
    expect(darkExplicitDeclarations.get('color-scheme')).toBe('dark');
    expect(darkMediaDeclarations.get('color-scheme')).toBe('dark');
  });

  it('holds identical declarations in the explicit dark block and the system dark block', () => {
    expect(darkExplicitDeclarations.size).toBeGreaterThan(40);
    expect(Object.fromEntries(darkMediaDeclarations)).toEqual(
      Object.fromEntries(darkExplicitDeclarations),
    );
  });

  it('does not change a token in dark that is not a colour', () => {
    for (const name of darkExplicitDeclarations.keys()) {
      if (name === 'color-scheme') continue;
      expect(names).toContain(name);
    }
  });
});
