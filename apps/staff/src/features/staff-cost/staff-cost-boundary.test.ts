import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Hard rule 7: the staff cost contracts (cost, supplier, stock) are only for staff code. Besides
// the staff-cost feature itself, only these other STAFF features may import them (staff product
// and price DTOs). Customer code, shared components, lib, i18n and the router never do.
const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAFF_FEATURES = ['staff-cost', 'staff-brands', 'catalog', 'pricing', 'search'];
const SELF = join(src, 'features', 'staff-cost', 'staff-cost-boundary.test.ts');
const IMPORT =
  /from\s+['"]@iorder\/shared\/staff-cost['"]|import\(\s*['"]@iorder\/shared\/staff-cost['"]\s*\)/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|vue)$/.test(name) && path !== SELF) yield path;
  }
}

describe('the staff cost contracts stay in staff code', () => {
  const importers = [...sources(src)]
    .filter((file) => IMPORT.test(readFileSync(file, 'utf8')))
    .map((file) => relative(src, file).split(sep).join('/'));

  it('finds the importers (the scan itself works)', () => {
    expect(importers.length).toBeGreaterThan(5);
    expect(importers).toContain('features/staff-cost/api/cost-api.ts');
  });

  it('is imported by no customer, shared or infrastructure file', () => {
    const outside = importers.filter(
      (file) => !STAFF_FEATURES.some((feature) => file.startsWith(`features/${feature}/`)),
    );
    expect(outside).toEqual([]);
  });
});
