import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKENS_FILE, listFrontendFiles, repoRelative } from '@core/test-utils/frontend-sources';

// Frontend rule: colours come from tokens only. This keeps a theme switch a token change.
// Scans non-test sources for colour literals outside styles/tokens.css.

const NAMED = [
  'white',
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'gray',
  'grey',
  'silver',
  'purple',
  'pink',
  'brown',
  'navy',
  'teal',
  'cyan',
  'magenta',
  'gold',
  'beige',
  'ivory',
  'maroon',
  'lime',
  'olive',
  'aqua',
  'fuchsia',
  'coral',
  'crimson',
  'indigo',
  'violet',
  'tomato',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNCTIONAL = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/;
const namedColourDeclaration = new RegExp(
  `(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|box-shadow|text-shadow)\\s*:[^;{}]*(?<![-\\w])(?:${NAMED.join('|')})(?![-(\\w])`,
  'i',
);

describe('raw colours', () => {
  const files = listFrontendFiles(
    (name) => /\.(vue|css|ts)$/.test(name) && !/\.(test|spec)\.ts$/.test(name),
  ).filter((file) => repoRelative(file) !== TOKENS_FILE);

  it('scans the sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no hex, rgb(), hsl() or named colour outside the token files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      // Only look at style declarations: <style> blocks, .css files and style bindings in templates.
      const styleText = file.endsWith('.css')
        ? source
        : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      const inline = [...source.matchAll(/style="([^"]*)"|:style="([^"]*)"/g)]
        .map((m) => m[1] ?? m[2] ?? '')
        .join('\n');
      const scanned = `${styleText}\n${inline}`;
      for (const [label, pattern] of [
        ['hex', HEX],
        ['functional', FUNCTIONAL],
        ['named', namedColourDeclaration],
      ] as const) {
        if (pattern.test(scanned)) offenders.push(`${repoRelative(file)} (${label})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no hex colour in TypeScript or script code either', () => {
    const offenders = files
      .filter((file) => !file.endsWith('.css'))
      .filter((file) =>
        HEX.test(stripComments(readFileSync(file, 'utf8')).replace(/<style[\s\S]*?<\/style>/g, '')),
      )
      .map((file) => repoRelative(file));
    expect(offenders).toEqual([]);
  });
});
