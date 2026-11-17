import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, TOKENS_FILE } from './frontend-sources';

// Test support: reads styles/tokens.css as text and returns the declarations of each theme.
// No browser is involved; `var(--x)` references are resolved with `resolveToken`.

export type Declarations = ReadonlyMap<string, string>;

const css = readFileSync(join(REPO_ROOT, TOKENS_FILE), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function parseDeclarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const index = part.indexOf(':');
    if (index === -1) continue;
    out.set(
      part.slice(0, index).trim(),
      part
        .slice(index + 1)
        .trim()
        .replace(/\s+/g, ' '),
    );
  }
  return out;
}

function bodies(pattern: RegExp): string[] {
  return [...css.matchAll(pattern)].map((m) => m[1] ?? '');
}

function merge(patternBodies: string[]): Declarations {
  return new Map(patternBodies.flatMap((body) => [...parseDeclarations(body)]));
}

// The light theme is every top-level `:root { }` block (a block at line start; the
// phone-padding override inside `@media (max-width)` is indented and holds no colour).
export const lightDeclarations: Declarations = merge(bodies(/^:root\s*\{([^}]*)\}/gm));

export const darkExplicitDeclarations: Declarations = merge(
  bodies(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/g),
);

export const darkMediaDeclarations: Declarations = merge(
  bodies(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/g,
  ),
);

/** A token is a colour token when its value is a colour literal, a shadow/overlay or a token alias. */
export function isColourValue(value: string): boolean {
  return /#[0-9a-f]{3,8}\b|rgba?\(|^var\(--[\w-]+\)$/i.test(value);
}

export function colourTokenNames(): string[] {
  return [...lightDeclarations]
    .filter(([name, value]) => name.startsWith('--') && isColourValue(value))
    .map(([name]) => name);
}

export type Theme = 'light' | 'dark';

export function themeDeclarations(theme: Theme): Declarations {
  return theme === 'light'
    ? lightDeclarations
    : new Map([...lightDeclarations, ...darkExplicitDeclarations]);
}

/** Follows `var(--other)` aliases until a literal is reached. */
export function resolveToken(theme: Theme, name: string): string {
  const declarations = themeDeclarations(theme);
  let value = declarations.get(name);
  for (let depth = 0; value !== undefined && depth < 10; depth += 1) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    if (!alias?.[1]) return value;
    value = declarations.get(alias[1]);
  }
  throw new Error(`Token ${name} does not resolve to a literal in the ${theme} theme`);
}

function channel(hex: string, index: number): number {
  const v = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
