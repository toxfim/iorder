import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Hard rule 7 and the lifecycle's customer view: the staff order contracts (accounting vocabulary,
// the skip marker, delivery contacts, staff routes) and the back-office orders UI are for staff
// code only. The bundle check proves it on the build; this proves it on the sources.
const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = join(src, 'features', 'staff-orders', 'staff-orders-boundary.test.ts');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|vue)$/.test(name) && path !== SELF) yield path;
  }
}

const files = [...sources(src)].map((file) => ({
  path: relative(src, file).split(sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const importing = (pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

describe('the staff order contracts stay in the staff-orders feature', () => {
  const ENTRY =
    /from\s+['"]@iorder\/shared\/staff-orders['"]|import\(\s*['"]@iorder\/shared\/staff-orders['"]\s*\)/;
  const importers = importing(ENTRY);

  it('finds the importers (the scan itself works)', () => {
    expect(importers.length).toBeGreaterThan(5);
    expect(importers).toContain('features/staff-orders/api/staff-orders-api.ts');
  });

  // The entry also carries the block-with-removal contract (staff-users.ts), whose only reader is
  // the staff-users feature (the block dialog and its removal status), and the organization
  // payments contract (organization-payments.ts), read by the staff-organizations feature (the
  // balance section). Both features are lazy staff chunks.
  it('is imported by nothing outside the staff-orders, staff-users and staff-organizations features', () => {
    expect(
      importers.filter(
        (file) =>
          !file.startsWith('features/staff-orders/') &&
          !file.startsWith('features/staff-users/') &&
          !file.startsWith('features/staff-organizations/'),
      ),
    ).toEqual([]);
  });
});

describe('the back-office orders code is not reachable from the customer entry', () => {
  // Static imports of the feature. The staff pages, the shell, the search and the type-only
  // service list may use it; the router and everything the entry loads may not.
  const STATIC = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]@\/features\/staff-orders\//;
  const ALLOWED_PREFIXES = [
    'features/staff-orders/',
    'features/dashboard/',
    'features/directory/',
    'features/search/',
    'features/staff-shell/',
    'test-utils/',
    'app/fake-services.ts',
    'app/create-real-services.ts', // loaded only through a dynamic import (create-services.ts)
    'app/services.ts', // types only
  ];

  it('is imported statically only by staff features', () => {
    const outside = importing(STATIC).filter(
      (file) =>
        !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) && !file.endsWith('.test.ts'),
    );
    expect(outside).toEqual([]);
  });

  it('is never imported statically by the router, the customer shell or the entry files', () => {
    for (const path of ['router/index.ts', 'main.ts', 'App.vue', 'router/guards.ts']) {
      expect(importing(STATIC)).not.toContain(path);
    }
    expect(importing(STATIC).filter((file) => file.startsWith('features/customer-shell/'))).toEqual(
      [],
    );
  });

  it('is loaded by the router only through dynamic imports in the shell route table', () => {
    const routes = files.find((file) => file.path === 'features/staff-shell/orders-routes.ts');
    expect(routes?.text).toMatch(/import\('@\/features\/staff-orders\/components\//);
    expect(routes?.text).not.toMatch(STATIC);
  });
});
