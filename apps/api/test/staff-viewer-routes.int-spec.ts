import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Actor } from '../src/common/auth/actor.js';
import { ActorResolver } from '../src/common/auth/actor-resolver.js';
import { toStaffViewerActor } from '../src/common/auth/staff-viewer.js';
import { PrismaService } from '../src/common/database/prisma.service.js';
import { APP_ENV } from '../src/config/config.module.js';
import { FakeUsdRateProvider } from '../src/modules/pricing/usd-rate/fake-usd-rate-provider.js';
import { UsdRateProvider } from '../src/modules/pricing/usd-rate/usd-rate-provider.js';
import { TELEGRAM_API_TRANSPORT } from '../src/modules/telegram/telegram.tokens.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN, signedInitData, tma } from './support/init-data.js';
import { ACTOR_HEADER } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';
import { getTestDatabaseUrl } from './support/test-env.js';

class HeaderActorResolver extends ActorResolver {
  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const raw = request.headers[ACTOR_HEADER];
    return raw ? (JSON.parse(raw) as Actor) : null;
  }
}

interface Route {
  method: string;
  path: string;
}

/** Every route the production module graph registers, read from the HTTP server itself. */
function registeredRoutes(app: INestApplication): Route[] {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack?: unknown[] };
    _router?: { stack?: unknown[] };
  };
  const stack = (instance.router?.stack ?? instance._router?.stack ?? []) as {
    route?: { path: string; methods: Record<string, boolean> };
  }[];
  return stack.flatMap((layer) =>
    layer.route === undefined
      ? []
      : Object.entries(layer.route.methods)
          .filter(([, on]) => on)
          .map(([method]) => ({
            method: method.toUpperCase(),
            path: (layer.route as { path: string }).path,
          })),
  );
}

const name = (route: Route): string => `${route.method} ${route.path}`;

/** The answer of one route to these credentials (guards run before validation). */
async function statusOf(
  baseUrl: string,
  route: Route,
  headers: Record<string, string>,
): Promise<number> {
  // Guards run before validation, so any well-formed id reaches the permission check.
  const path = route.path.replace(/:\w+/g, () => randomUUID());
  const response = await fetch(`${baseUrl}${path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { body: '{}' }),
  });
  await response.arrayBuffer();
  return response.status;
}

// What a staff viewer of the customer app may reach ([C] 2026-11-09), written by hand: a route
// that opens to a viewer must be added here on purpose. Reaching a route is not the same as
// getting data from it (the orders routes answer empty or 404, see staff-viewer.int-spec.ts).
const VIEWER_ROUTES = [
  'GET /me',
  'GET /auth/session',
  'POST /auth/logout',
  'GET /price-list/current',
  'GET /cart',
  'PUT /cart/items/:productId',
  'DELETE /cart/items/:productId',
  'POST /orders',
  'GET /orders',
  'GET /orders/:id',
  'GET /orders/:id/timeline',
  'GET /me/balance',
  'GET /me/products/summary',
  'GET /me/products',
  'GET /me/products/:productId',
  'GET /me/products/:productId/units/:unitId',
  // The home recommendations: the service answers three empty blocks for a viewer.
  'GET /me/recommendations',
];

// Routes that need no sign-in at all (they verify their own proof or serve public files).
const PUBLIC_ROUTES = [
  'GET /health',
  'POST /auth/telegram-widget',
  'POST /auth/password-login',
  'POST /customer/auth/password-login',
  'POST /customer/auth/telegram-widget',
  // The one-time handoff from the dashboard and the address of its page ([C] 2026-11-09).
  'POST /customer/auth/handoff',
  'GET /customer/auth/handoff',
  'GET /media/product-images/:imageId/:variant',
  'POST /telegram/webhook/:secret',
  // The staff bot's webhook: the same secret proof, its own secret ([C] 2026-11-10).
  'POST /telegram/webhook-staff/:secret',
];

// The production module graph (AppModule), a real database and real HTTP: the viewer actor is
// sent to EVERY registered route, so "everything else stays closed" is proven for routes that do
// not exist yet when this is written.
describe('a staff viewer against every route of the real AppModule', () => {
  let app: INestApplication;
  let baseUrl: string;
  let routes: Route[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENV)
      .useValue({ NODE_ENV: 'test', PORT: 0, DATABASE_URL: getTestDatabaseUrl() })
      .overrideProvider(ActorResolver)
      .useClass(HeaderActorResolver)
      .overrideProvider(UsdRateProvider)
      .useValue(new FakeUsdRateProvider())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    routes = registeredRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const statusFor = (route: Route, actor: Actor): Promise<number> =>
    statusOf(baseUrl, route, { [ACTOR_HEADER]: JSON.stringify(actor) });

  /** The routes that do NOT turn this actor away with 403. */
  const notForbidden = async (actor: Actor): Promise<string[]> => {
    const open: string[] = [];
    for (const route of routes) {
      if ((await statusFor(route, actor)) !== 403) open.push(name(route));
    }
    return open.sort();
  };

  it('finds the routes of the app (the sweep is not empty by accident)', () => {
    expect(routes.length).toBeGreaterThan(100);
    const names = routes.map(name);
    for (const expected of [...VIEWER_ROUTES, ...PUBLIC_ROUTES, 'GET /staff/orders']) {
      expect(names).toContain(expected);
    }
  });

  // What a viewer SESSION resolves to (staff-session.service) for each role that may be a viewer.
  it.each(['MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'] as const)(
    'a viewer session of a %s is refused by every route outside the short list, every staff route included',
    async (role) => {
      const viewer = toStaffViewerActor({ userId: randomUUID(), staffRoles: [role] }, null, {
        sessionId: randomUUID(),
      });
      const open = await notForbidden(viewer);
      expect(open).toEqual([...VIEWER_ROUTES, ...PUBLIC_ROUTES].sort());
      expect(open.filter((route) => route.includes('/staff'))).toEqual([]);
    },
  );

  it('with an organization for staff orders the list of reachable routes is the same', async () => {
    const viewer = toStaffViewerActor(
      { userId: randomUUID(), staffRoles: ['MANAGER'] },
      randomUUID(),
    );
    expect(await notForbidden(viewer)).toEqual([...VIEWER_ROUTES, ...PUBLIC_ROUTES].sort());
  });

  it('staff whose roles do not open the customer app reach nothing as viewers', async () => {
    for (const role of ['DRIVER', 'WAREHOUSE_MANAGER'] as const) {
      const nobody = toStaffViewerActor({ userId: randomUUID(), staffRoles: [role] }, null);
      expect(await notForbidden(nobody)).toEqual([...PUBLIC_ROUTES].sort());
    }
  });

  it('the staff routes still reject customer accounts', async () => {
    const customer: Actor = {
      userId: randomUUID(),
      staffRoles: [],
      membership: { organizationId: randomUUID(), role: 'SHOP_OWNER' },
    };
    const open = await notForbidden(customer);
    expect(open.filter((route) => route.includes('/staff'))).toEqual([]);
  });
});

// The same sweep with the PRODUCTION resolver and two bots (security review 2026-11-09): one bot
// used to sign the init data of both Mini Apps, so what the CUSTOMER app held for a staff member
// also opened /staff routes. With STAFF_MINI_APP_BOT_TOKEN set, main-bot init data must be a
// viewer (or nobody) on every route, and only the staff bot makes a staff actor.
describe('Mini App init data against every route, staff bound to the staff bot', () => {
  const STAFF_BOT_TOKEN = '737373:FAKE-staff-mini-app-bot-token';
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let routes: Route[];
  const telegramCalls: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 0,
        DATABASE_URL: getTestDatabaseUrl(),
        TELEGRAM_MODE: 'off',
        BOT_TOKEN: FAKE_BOT_TOKEN,
        STAFF_MINI_APP_BOT_TOKEN: STAFF_BOT_TOKEN,
      })
      // Nothing here may reach Telegram: a call would be recorded and fail the last test.
      .overrideProvider(TELEGRAM_API_TRANSPORT)
      .useValue(async (method: string) => {
        telegramCalls.push(method);
        return { ok: false, error_code: 500, description: 'no network in tests' };
      })
      .overrideProvider(UsdRateProvider)
      .useValue(new FakeUsdRateProvider())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    routes = registeredRoutes(app);
    prisma = moduleRef.get(PrismaService, { strict: false });
    await resetIdentity(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  const fromMainBot = (telegramUserId: bigint): Record<string, string> =>
    tma(signedInitData({ telegramUserId, now: new Date() }));
  const fromStaffBot = (telegramUserId: bigint): Record<string, string> =>
    tma(signedInitData({ telegramUserId, now: new Date(), token: STAFF_BOT_TOKEN }));

  /** The routes that answer these credentials with anything but `refused`. */
  const notAnswering = async (
    refused: number,
    headers: Record<string, string>,
  ): Promise<string[]> => {
    const open: string[] = [];
    for (const route of routes) {
      if ((await statusOf(baseUrl, route, headers)) !== refused) open.push(name(route));
    }
    return open.sort();
  };
  const get = async (path: string, headers: Record<string, string>) => {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  };

  it.each(['MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'] as const)(
    'main bot init data of a %s is refused by every staff route: it reaches only the viewer list',
    async (role) => {
      const staff = await makeUser(prisma, { staff: [role] });
      const open = await notAnswering(403, fromMainBot(staff.telegramUserId));
      expect(open).toEqual([...VIEWER_ROUTES, ...PUBLIC_ROUTES].sort());
      expect(open.filter((route) => route.includes('/staff'))).toEqual([]);
    },
  );

  it.each(['DRIVER', 'WAREHOUSE_MANAGER'] as const)(
    'main bot init data of a %s is nobody: 401 on every route that needs a sign-in',
    async (role) => {
      const staff = await makeUser(prisma, { staff: [role] });
      const open = await notAnswering(401, fromMainBot(staff.telegramUserId));
      expect(open).toEqual([...PUBLIC_ROUTES].sort());
    },
  );

  it('staff bot init data is the staff actor on staff routes and the viewer on customer routes', async () => {
    const manager = await makeUser(prisma, { staff: ['MANAGER'] });
    const headers = fromStaffBot(manager.telegramUserId);
    expect((await get('/staff/users', headers)).status).toBe(200);
    expect((await get('/staff/orders', headers)).status).toBe(200);
    expect((await get('/auth/session', headers)).body).toMatchObject({
      session: null,
      me: { userId: manager.id, staffRoles: ['MANAGER'], membership: null },
    });
    // Customer-area routes: the guard turns the staff actor into the viewer, as for any staff.
    expect((await get('/cart', headers)).status).toBe(200);
    expect((await get('/orders', headers)).body).toEqual({ orders: [], nextCursor: null });
    expect((await get('/me/balance', headers)).status).toBe(200);
  });

  it('the same person: the staff bot opens the staff routes, the main bot does not', async () => {
    const admin = await makeUser(prisma, { staff: ['ADMIN'] });
    expect((await get('/staff/users', fromStaffBot(admin.telegramUserId))).status).toBe(200);
    expect((await get('/staff/users', fromMainBot(admin.telegramUserId))).status).toBe(403);
    expect((await get('/auth/session', fromMainBot(admin.telegramUserId))).body).toMatchObject({
      me: { userId: admin.id, staffRoles: [] },
    });
  });

  it('a customer is a member through the main bot and nobody through the staff bot', async () => {
    const organization = await makeOrganization(prisma);
    const seller = await makeUser(prisma);
    await makeMember(prisma, organization.id, seller.id, 'SELLER');

    const main = fromMainBot(seller.telegramUserId);
    expect((await get('/me', main)).body).toMatchObject({
      staffRoles: [],
      membership: { organizationId: organization.id, role: 'SELLER' },
    });
    expect((await get('/staff/users', main)).status).toBe(403);

    const open = await notAnswering(401, fromStaffBot(seller.telegramUserId));
    expect(open).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('never called Telegram', () => {
    expect(telegramCalls).toEqual([]);
  });
});
