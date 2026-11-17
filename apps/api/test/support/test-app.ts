import type { ExecutionContext, INestApplication, Type } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { Actor } from '../../src/common/auth/actor.js';
import { ActorResolver } from '../../src/common/auth/actor-resolver.js';
import { PermissionGuard } from '../../src/common/auth/permission.guard.js';
import { Clock, ClockModule } from '../../src/common/clock/clock.js';
import { DatabaseModule } from '../../src/common/database/database.module.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { applyBodyLimit } from '../../src/common/http/body-limit.js';
import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter.js';
import { APP_ENV } from '../../src/config/config.module.js';
import type { Env } from '../../src/config/env.js';
import { FakeUsdChannelRateProvider } from '../../src/modules/pricing/usd-rate/fake-usd-channel-rate-provider.js';
import { FakeUsdRateProvider } from '../../src/modules/pricing/usd-rate/fake-usd-rate-provider.js';
import { UsdChannelRateProvider } from '../../src/modules/pricing/usd-rate/usd-channel-rate-provider.js';
import { UsdRateProvider } from '../../src/modules/pricing/usd-rate/usd-rate-provider.js';
import { getTestDatabaseUrl } from './test-env.js';

export const ACTOR_HEADER = 'x-test-actor';

const REJECTED_KEY = 'resolverRejects';

/**
 * An actor the resolver turns away. The production resolver returns no actor for a BLOCKED user,
 * an unknown user or an inactive organization (see telegram-actor.resolver); a test actor marked
 * this way makes the header resolver answer the same: "no actor", so the guard replies 401.
 */
export function rejectedByResolver(actor: Actor, reason: 'BLOCKED' | 'UNKNOWN'): Actor {
  return { ...actor, [REJECTED_KEY]: reason } as Actor;
}

/** TEST-ONLY resolver: reads the actor from a header. Never registered in AppModule. */
class HeaderActorResolver extends ActorResolver {
  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const raw = request.headers[ACTOR_HEADER];
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Actor & { [REJECTED_KEY]?: string };
    return parsed[REJECTED_KEY] === undefined ? parsed : null;
  }
}

/** A clock tests can move. */
export class FakeClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  set(next: Date): void {
    this.current = next;
  }
}

/** Makes APP_ENV visible to PrismaService in DatabaseModule, like the global ConfigModule does. */
function testConfigModule(botToken: string | undefined, extra: Partial<Env>): Type {
  @Global()
  @Module({
    providers: [
      {
        provide: APP_ENV,
        useFactory: () => ({
          DATABASE_URL: getTestDatabaseUrl(),
          ...(botToken === undefined ? {} : { BOT_TOKEN: botToken }),
          ...extra,
        }),
      },
    ],
    exports: [APP_ENV],
  })
  class TestConfigModule {}
  return TestConfigModule;
}

export interface TestApp {
  app: INestApplication;
  /** Replaces the real Central Bank client in every test app: no test touches the network. */
  usdRateProvider: FakeUsdRateProvider;
  usdChannelProvider: FakeUsdChannelRateProvider;
  prisma: PrismaService;
  clock: FakeClock;
  get<T>(token: Type<T>): T;
  request(
    method: string,
    path: string,
    options?: { actor?: Actor; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown; headers: Headers; raw: string }>;
  close(): Promise<void>;
}

export const MANAGER: Actor = { userId: 'user-manager', staffRoles: ['MANAGER'] };
export const ADMIN: Actor = { userId: 'user-admin', staffRoles: ['ADMIN'] };
export const ACCOUNTANT: Actor = { userId: 'user-accountant', staffRoles: ['ACCOUNTANT'] };
export const WAREHOUSE: Actor = { userId: 'user-wh', staffRoles: ['WAREHOUSE_MANAGER'] };
export const DRIVER: Actor = { userId: 'user-driver', staffRoles: ['DRIVER'] };
/** A manager as the staff viewer of the customer app ([C] 2026-11-09): no staff role, no organization. */
export const STAFF_VIEWER: Actor = {
  userId: 'user-manager',
  staffRoles: [],
  staffViewer: { staffRoles: ['MANAGER'], orderingOrganizationId: null },
};
export const SHOP_OWNER: Actor = {
  userId: 'user-owner',
  staffRoles: [],
  membership: { organizationId: 'org-1', role: 'SHOP_OWNER' },
};
export const SELLER: Actor = {
  userId: 'user-seller',
  staffRoles: [],
  membership: { organizationId: 'org-1', role: 'SELLER' },
};

export interface TestAppOptions {
  /**
   * Configures a (fake) bot token and uses the PRODUCTION actor resolver from IdentityModule
   * instead of the header resolver. `request` then sends `headers.authorization` only.
   */
  botToken?: string;
  /** Extra environment values (for example TELEGRAM_MODE); merged over the test defaults. */
  env?: Partial<Env>;
  /** Replaces providers (for example the Telegram sender or API transport with a fake). */
  overrides?: ReadonlyArray<{ token: unknown; value: unknown }>;
}

/** Real Nest app on a real database, with the production guard and filter and a test actor resolver. */
export async function createTestApp(
  feature: Type[],
  options: TestAppOptions = {},
): Promise<TestApp> {
  const usdRateProvider = new FakeUsdRateProvider();
  const usdChannelProvider = new FakeUsdChannelRateProvider();
  const clock = new FakeClock(new Date('2026-10-20T08:00:00Z'));
  let builder = Test.createTestingModule({
    imports: [
      testConfigModule(options.botToken, options.env ?? {}),
      ClockModule,
      DatabaseModule,
      ...feature,
    ],
    providers: [
      ...(options.botToken === undefined
        ? [{ provide: ActorResolver, useClass: HeaderActorResolver }]
        : []),
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_GUARD, useClass: PermissionGuard },
    ],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(UsdRateProvider)
    .useValue(usdRateProvider)
    .overrideProvider(UsdChannelRateProvider)
    .useValue(usdChannelProvider);
  for (const { token, value } of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  applyBodyLimit(app);
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;

  return {
    app,
    usdRateProvider,
    usdChannelProvider,
    prisma: moduleRef.get(PrismaService),
    clock,
    get: (token) => moduleRef.get(token, { strict: false }),
    async request(method, path, options = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...options.headers,
          ...(options.actor ? { [ACTOR_HEADER]: JSON.stringify(options.actor) } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
        headers: response.headers,
        raw: text,
      };
    },
    close: () => app.close(),
  };
}
