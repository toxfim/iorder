import { STAFF_ROLES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { safeRedirect } from '@/features/auth/redirect';
import {
  STAFF_PAGES,
  firstStaffPage,
  navGroupsFor,
  staffRouteName,
  visibleStaffPages,
} from '@/features/staff-shell/nav-config';
import { createAppRouter } from './index';

async function routerFor(identityId?: string): Promise<Router> {
  const api = createFakeAuthApi({ initialIdentityId: identityId });
  const router = createAppRouter(createCurrentUserStore(api), createMemoryHistory());
  return router;
}

async function visit(identityId: string | undefined, path: string) {
  const router = await routerFor(identityId);
  await router.push(path);
  return router.currentRoute.value;
}

describe('route groups', () => {
  it('the staff group is lazy-loaded (its own chunk)', async () => {
    const router = await routerFor();
    // Group records are the top-level ones with children (nested sections such as the prices
    // pages are not groups); a lazy component is still an unresolved function.
    const groups = router
      .getRoutes()
      .filter((r) => r.children.length > 0 && r.path.split('/').length <= 2);
    expect(groups.map((r) => r.path)).toEqual(['/staff']);
    for (const group of groups) {
      expect(typeof group.components?.default).toBe('function');
    }
  });
});

describe('guards: signed out', () => {
  it('sends staff pages to login', async () => {
    const route = await visit(undefined, '/staff/orders');
    expect(route.name).toBe('login');
    expect(route.query.redirect).toBe('/staff/orders');
  });

  it('lets the login and forbidden pages through', async () => {
    expect((await visit(undefined, '/login')).name).toBe('login');
    expect((await visit(undefined, '/forbidden')).name).toBe('forbidden');
  });
});

describe('guards: staff roles', () => {
  const landing: Record<string, string> = {
    admin: 'staff-dashboard',
    manager: 'staff-dashboard',
    accountant: 'staff-accounting',
    warehouse: 'staff-warehouse',
    driver: 'staff-deliveries',
  };

  for (const [identity, expected] of Object.entries(landing)) {
    it(`${identity} lands on ${expected} when opening /staff`, async () => {
      expect((await visit(identity, '/staff')).name).toBe(expected);
    });
  }

  it('lets admin and manager into the staff accounts page', async () => {
    expect((await visit('admin', '/staff/employees')).name).toBe('staff-employees');
    expect((await visit('manager', '/staff/employees')).name).toBe('staff-employees');
  });

  it('keeps the queue roles out of the staff accounts page', async () => {
    for (const identity of ['accountant', 'warehouse', 'driver']) {
      expect((await visit(identity, '/staff/employees')).name).toBe('forbidden');
    }
  });

  it('keeps each queue role out of the other roles pages', async () => {
    expect((await visit('accountant', '/staff/orders')).name).toBe('forbidden');
    expect((await visit('accountant', '/staff/deliveries')).name).toBe('forbidden');
    expect((await visit('driver', '/staff/prices')).name).toBe('forbidden');
    expect((await visit('warehouse', '/staff/customers')).name).toBe('forbidden');
  });

  it('allows a role into its own page', async () => {
    expect((await visit('accountant', '/staff/accounting')).name).toBe('staff-accounting');
    expect((await visit('driver', '/staff/deliveries')).name).toBe('staff-deliveries');
  });
});

// Customers have their own app (apps/customer); here they are signed-in people without a staff role.
describe('guards: people without a staff role', () => {
  it('sends every kind of user to their own home from / and from unknown URLs', async () => {
    for (const path of ['/', '/no/such/page']) {
      expect((await visit('manager', path)).name).toBe('staff-dashboard');
      expect((await visit('driver', path)).name).toBe('staff-deliveries');
      expect((await visit('owner', path)).name).toBe('forbidden');
      expect((await visit('outsider', path)).name).toBe('forbidden');
      expect((await visit(undefined, path)).name).toBe('login');
    }
  });

  it('keeps customers out of the staff area', async () => {
    expect((await visit('owner', '/staff')).name).toBe('forbidden');
    expect((await visit('seller', '/staff/orders')).name).toBe('forbidden');
  });

  it('shows forbidden to a signed-in person with no role at all', async () => {
    expect((await visit('outsider', '/staff')).name).toBe('forbidden');
  });
});

describe('guards: signed in on the login page', () => {
  it('bounces to the persons home', async () => {
    expect((await visit('manager', '/login')).name).toBe('staff-dashboard');
    expect((await visit('owner', '/login')).name).toBe('forbidden');
  });
});

// Inside Telegram (the tab holds init data) a refused person gets the screen that says what to
// do; outside Telegram every answer above stays as it is.
describe('guards: opened from Telegram', () => {
  async function visitFromTelegram(identityId: string | undefined, path: string) {
    const api = createFakeAuthApi({ initialIdentityId: identityId });
    const router = createAppRouter(createCurrentUserStore(api), createMemoryHistory(), undefined, {
      viaTelegram: () => true,
    });
    await router.push(path);
    return router.currentRoute.value;
  }

  it('nobody signed in: the Telegram screen with the page as the return path, not the form', async () => {
    const route = await visitFromTelegram(undefined, '/staff/orders');
    expect(route.name).toBe('telegram-refused');
    expect(route.query.redirect).toBe('/staff/orders');
  });

  it('the login form stays reachable for someone who is not signed in', async () => {
    expect((await visitFromTelegram(undefined, '/login')).name).toBe('login');
  });

  it('a person without a staff role gets the Telegram screen everywhere', async () => {
    for (const path of ['/staff/orders', '/', '/login', '/forbidden']) {
      expect((await visitFromTelegram('owner', path)).name).toBe('telegram-refused');
    }
  });

  it('staff are not kept on the Telegram screen and work as on the website', async () => {
    expect((await visitFromTelegram('manager', '/telegram-sign-in')).name).toBe('staff-dashboard');
    expect((await visitFromTelegram('manager', '/staff/orders')).name).toBe('staff-orders');
    expect((await visitFromTelegram('driver', '/staff/orders')).name).toBe('forbidden');
  });
});

describe('guards: the Telegram screen outside Telegram', () => {
  it('has nothing to explain: the ordinary sign-in or home applies', async () => {
    expect((await visit(undefined, '/telegram-sign-in')).name).toBe('login');
    expect((await visit('owner', '/telegram-sign-in')).name).toBe('forbidden');
    expect((await visit('manager', '/telegram-sign-in')).name).toBe('staff-dashboard');
  });
});

describe('staff navigation config', () => {
  it('only references real staff roles', () => {
    for (const page of STAFF_PAGES) {
      for (const role of page.roles) expect(STAFF_ROLES).toContain(role);
    }
  });

  it('has unique keys and paths', () => {
    expect(new Set(STAFF_PAGES.map((p) => p.key)).size).toBe(STAFF_PAGES.length);
    expect(new Set(STAFF_PAGES.map((p) => p.path)).size).toBe(STAFF_PAGES.length);
  });

  it('gives every route the same roles as its sidebar entry', async () => {
    const router = await routerFor();
    for (const page of STAFF_PAGES) {
      // The resolved meta is what the guard sees; a section may keep the roles on its parent.
      const resolved = router.resolve({ name: staffRouteName(page) });
      expect(resolved.meta.staffRoles).toEqual(page.roles);
    }
  });

  it('shows each role only its own entries, in group order', () => {
    const labels = (roles: Parameters<typeof navGroupsFor>[0]) =>
      navGroupsFor(roles).map((g) => [g.group, g.pages.map((p) => p.key)]);

    expect(labels(['ADMIN'])).toEqual([
      ['general', ['dashboard']],
      ['warehouse', ['stock', 'byOrder']],
      ['sales', ['prices', 'brands', 'customers', 'organizations']],
      ['system', ['employees', 'history', 'botSettings', 'profile']],
    ]);
    expect(labels(['MANAGER'])).toEqual([
      ['general', ['dashboard']],
      ['warehouse', ['stock', 'byOrder']],
      ['sales', ['prices', 'brands', 'customers', 'organizations']],
      ['system', ['employees', 'history', 'botSettings', 'profile']],
    ]);
    // The accountant reads prices (with cost) and stock; warehouse and driver see neither.
    // Design v8 puts the stock in its own "Ombor" section above "Savdo".
    // Design v8: their Orders group (own queue) opens the general section.
    // Every role has its own profile in the system section.
    expect(labels(['ACCOUNTANT'])).toEqual([
      ['general', []],
      ['warehouse', ['stock', 'byOrder']],
      ['sales', ['prices']],
      ['system', ['profile']],
    ]);
    expect(labels(['WAREHOUSE_MANAGER'])).toEqual([
      ['general', []],
      ['system', ['profile']],
    ]);
    expect(labels(['DRIVER'])).toEqual([
      ['general', []],
      ['system', ['profile']],
    ]);
    expect(labels([])).toEqual([]);
  });

  it('every staff role has somewhere to land', () => {
    for (const role of STAFF_ROLES) {
      expect(firstStaffPage([role])).toBeDefined();
      expect(visibleStaffPages([role]).length).toBeGreaterThan(0);
    }
  });
});

describe('safeRedirect', () => {
  it('accepts same-origin paths', () => {
    expect(safeRedirect('/staff/orders')).toBe('/staff/orders');
    expect(safeRedirect('/cart?x=1#y')).toBe('/cart?x=1#y');
  });

  it('rejects anything that could leave the site', () => {
    for (const bad of [
      '//evil.test',
      'https://evil.test',
      'javascript:alert(1)',
      '/\\evil.test',
      '/\t/evil.test',
      'staff',
      '',
      null,
      undefined,
      ['/a'],
      42,
    ]) {
      expect(safeRedirect(bad)).toBeNull();
    }
  });
});
