import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { createAppRouter } from '@/router';

async function visit(identityId: string | undefined, path: string) {
  const api = createFakeAuthApi({ initialIdentityId: identityId });
  const router = createAppRouter(createCurrentUserStore(api), createMemoryHistory());
  await router.push(path);
  return router.currentRoute.value;
}

describe('price section routes and role guards', () => {
  const pages: [string, string][] = [
    ['/staff/prices', 'staff-prices'],
    ['/staff/prices/versions', 'staff-price-versions'],
    ['/staff/prices/versions/abc', 'staff-price-version'],
    ['/staff/prices/products', 'staff-products'],
    ['/staff/prices/newer-models', 'staff-newer-models'],
    ['/staff/prices/categories', 'staff-product-categories'],
  ];

  for (const identity of ['manager', 'admin']) {
    for (const [path, name] of pages) {
      it(`${identity} may open ${path}`, async () => {
        expect((await visit(identity, path)).name).toBe(name);
      });
    }
  }

  for (const identity of ['warehouse', 'driver']) {
    it(`${identity} is sent to the denied page for every price route`, async () => {
      for (const [path] of pages) {
        expect((await visit(identity, path)).name).toBe('forbidden');
      }
    });
  }

  // The accountant reads the current list with its cost, but versions, drafts and product
  // management belong to the people who change prices (the api refuses the accountant there too).
  it('lets the accountant open the current list only', async () => {
    expect((await visit('accountant', '/staff/prices')).name).toBe('staff-prices');
    for (const [path] of pages.slice(1)) {
      expect((await visit('accountant', path)).name).toBe('forbidden');
    }
  });

  it('opens the stock page for manager, accountant and admin only', async () => {
    for (const identity of ['manager', 'accountant', 'admin']) {
      expect((await visit(identity, '/staff/stock')).name).toBe('staff-stock');
    }
    for (const identity of ['warehouse', 'driver']) {
      expect((await visit(identity, '/staff/stock')).name).toBe('forbidden');
    }
  });

  it('sends a signed-out visitor to login', async () => {
    expect((await visit(undefined, '/staff/prices/versions')).name).toBe('login');
  });
});

// CLAUDE.md frontend conventions: colours come from design tokens only. A stray hex or rgb()
// literal in a component would silently grow the palette.
describe('price components use tokens only', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  function* vueFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* vueFiles(path);
      else if (name.endsWith('.vue')) yield path;
    }
  }

  const files = [
    ...vueFiles(join(root, 'pricing')),
    ...vueFiles(join(root, 'catalog')),
    ...vueFiles(join(root, 'staff-cost')),
    join(root, '..', '..', '..', '..', 'packages/web-core/src/components/ui/AppConfirmDialog.vue'),
    join(root, '..', '..', '..', '..', 'packages/web-core/src/components/ui/AppTabs.vue'),
  ];

  it('finds the components', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(`${file.split(/[\\/]/).slice(-2).join('/')} has no colour literals`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
      expect(source.match(/\brgba?\(/g) ?? []).toEqual([]);
    });
  }
});
