import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source scans for the staff accounts page and the block dialog: staff-only code stays out of the
// customer bundle's entry points, and a password never reaches a log, a storage or a URL.
// check-bundle.mjs checks the build; this checks the sources.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) yield path;
  }
}

const files = [...walk(SRC)].map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));
const own = files.filter((file) => file.path.startsWith('features/staff-users/'));
const matching = (pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

describe('staff users code stays in staff areas', () => {
  it('finds its own sources (the scan itself works)', () => {
    expect(own.length).toBeGreaterThan(10);
  });

  it('is never imported statically by the entry, the router, the customer shell or the customer app', () => {
    const STATIC = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]@\/features\/staff-users\//;
    const importers = matching(STATIC);
    for (const path of ['router/index.ts', 'main.ts', 'App.vue', 'router/guards.ts']) {
      expect(importers).not.toContain(path);
    }
    expect(importers.filter((file) => /^features\/customer-/.test(file))).toEqual([]);
  });

  it('is loaded by the router only through a dynamic import', () => {
    const router = files.find((file) => file.path === 'router/index.ts');
    expect(router?.text).toMatch(
      /import\('@\/features\/staff-users\/components\/StaffAccountsPage\.vue'\)/,
    );
  });

  it('keeps the account contract entries in staff features', () => {
    const entry = /@iorder\/shared\/staff-(?:auth|orders)/;
    const outside = matching(entry).filter(
      (file) =>
        !file.startsWith('features/staff') && !/^features\/(?:pricing|catalog|search)\//.test(file),
    );
    expect(outside).toEqual([]);
  });
});

describe('a password never leaves the form', () => {
  it('is not logged, stored, put in a cookie or read from the URL by any staff users source', () => {
    for (const file of own) {
      expect(file.text, file.path).not.toMatch(/console\.\w+/);
      expect(file.text, file.path).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(file.text, file.path).not.toMatch(
        /window\.location|router\.(?:push|replace)|\$router/,
      );
      expect(file.text, file.path).not.toMatch(/Math\.random/);
    }
  });

  it('draws generated passwords from the crypto source only', () => {
    const generators = own.filter((file) => /getRandomValues/.test(file.text));
    expect(generators.map((file) => file.path)).toEqual([
      'features/staff-users/domain/password-generator.ts',
    ]);
  });

  it('finds a password in an attribute written over several lines (the scan itself works)', () => {
    expect(
      passwordInAttributes(`<a
  :aria-label="
    shown ? password : ''
  "
/>`),
    ).toHaveLength(1);
    expect(
      passwordInAttributes(`<a :title="foo(
 password
)" />`),
    ).toHaveLength(1);
    // A message key that merely contains the word is not a value.
    expect(
      passwordInAttributes(`<a :aria-label="t('staffUsers.accounts.create.password')" />`),
    ).toEqual([]);
  });

  it('never renders a password into a title, aria-label, query or route param', () => {
    const vueFiles = own.filter((f) => f.path.endsWith('.vue'));
    expect(own.length).toBeGreaterThan(10);
    expect(vueFiles.length).toBeGreaterThan(5);
    for (const file of vueFiles) {
      expect(passwordInAttributes(file.text), file.path).toEqual([]);
    }
  });
});

/**
 * Attribute values (quoted, possibly spread over several lines) of title, aria-label, to, query
 * and params that use the identifier `password`. String literals are removed first, so an i18n
 * key such as 'staffUsers.accounts.create.password' is not mistaken for the value itself.
 */
function passwordInAttributes(source: string): string[] {
  const attribute = /(?:^|\s):?(?:aria-label|title|to|query|params)\s*=\s*"([^"]*)"/g;
  return [...source.matchAll(attribute)]
    .map((match) => (match[1] ?? '').replace(/'[^']*'|`[^`]*`/g, "''"))
    .filter((value) => /\bpassword\b/i.test(value));
}
