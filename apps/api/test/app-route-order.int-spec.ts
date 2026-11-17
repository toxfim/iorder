import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { unpricedProductsResponseSchema } from '@iorder/shared/staff-cost';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Actor } from '../src/common/auth/actor.js';
import { ActorResolver } from '../src/common/auth/actor-resolver.js';
import { APP_ENV } from '../src/config/config.module.js';
import { FakeUsdRateProvider } from '../src/modules/pricing/usd-rate/fake-usd-rate-provider.js';
import { UsdRateProvider } from '../src/modules/pricing/usd-rate/usd-rate-provider.js';
import { ACTOR_HEADER, MANAGER } from './support/test-app.js';
import { getTestDatabaseUrl } from './support/test-env.js';

class HeaderActorResolver extends ActorResolver {
  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const raw = request.headers[ACTOR_HEADER];
    return raw ? (JSON.parse(raw) as Actor) : null;
  }
}

// The production module graph (AppModule, with its real import order), a real database and real
// HTTP. `GET /staff/products/unpriced` also matches the catalog's `GET /staff/products/:id`;
// Nest registers routes in module order, so a reordered AppModule would answer 422 here.
describe('real AppModule route order', () => {
  let app: INestApplication;
  let baseUrl: string;

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
  });

  afterAll(async () => {
    await app.close();
  });

  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { [ACTOR_HEADER]: JSON.stringify(MANAGER) },
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it('GET /staff/products/unpriced is served by the stock controller, not by /staff/products/:id', async () => {
    const unpriced = await get('/staff/products/unpriced');
    expect(unpriced.status).toBe(200);
    expect(unpricedProductsResponseSchema.safeParse(unpriced.body).success).toBe(true);
  });

  it('a real id route still answers for ids (a non-UUID id is a 422)', async () => {
    expect((await get('/staff/products/not-a-uuid')).status).toBe(422);
  });
});
