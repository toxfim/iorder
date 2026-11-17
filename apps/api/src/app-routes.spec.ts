import type { INestApplication } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { PermissionGuard } from './common/auth/permission.guard.js';
import { readRoutePolicy } from './common/auth/route-access.js';
import { PrismaService } from './common/database/prisma.service.js';
import { APP_ENV } from './config/config.module.js';

// Nest stores the HTTP verb and path of a route handler under this metadata key.
const PATH_METADATA = 'path';

describe('real AppModule access policy', () => {
  let app: INestApplication;
  let container: ModulesContainer;

  beforeAll(async () => {
    // No database is needed: only wiring and decorator metadata are inspected.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENV)
      .useValue({ NODE_ENV: 'test', PORT: 0, DATABASE_URL: 'postgresql://unused' })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    container = moduleRef.get(ModulesContainer);
    app = moduleRef.createNestApplication();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers the permission guard globally', () => {
    const registered = [...container.values()].some((module) =>
      [...module.providers.values()].some((wrapper) => wrapper.metatype === PermissionGuard),
    );
    expect(registered).toBe(true);
  });

  it('every route declares @RequirePermission or @Public', () => {
    const reflector = new Reflector();
    const undeclared: string[] = [];
    let routes = 0;

    for (const module of container.values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        if (!controller) continue;
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
          routes += 1;
          const policy = readRoutePolicy(reflector, handler, controller);
          if (policy === null) undeclared.push(`${controller.name}.${name}`);
        }
      }
    }

    expect(routes).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });

  it('keeps GET /health reachable through the global guard', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
  });
});

// Fail closed: the real app only has an actor resolver when a bot token is configured, and
// there is no flag that skips verification.
describe.each([
  ['without a bot token', undefined],
  ['with a bot token', '123456:FAKE-token-for-wiring-test'],
])('real AppModule %s', (_name, botToken) => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 0,
        DATABASE_URL: 'postgresql://unused',
        ...(botToken === undefined ? {} : { BOT_TOKEN: botToken }),
      })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  const call = async (path: string, headers: Record<string, string>): Promise<number> => {
    const { port } = app.getHttpServer().address() as AddressInfo;
    return (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status;
  };

  it.each(['/me', '/staff/users', '/staff/drivers', '/staff/organizations', '/staff/products'])(
    '401 for %s with no credentials, a bogus tma header or a bogus test header',
    async (path) => {
      expect(await call(path, {})).toBe(401);
      expect(await call(path, { authorization: 'tma user=%7B%7D&auth_date=1&hash=00' })).toBe(401);
      expect(await call(path, { 'x-test-actor': '{"userId":"u","staffRoles":["ADMIN"]}' })).toBe(
        401,
      );
    },
  );

  it('keeps /health public either way', async () => {
    expect(await call('/health', {})).toBe(200);
  });
});

// Guards the walker itself: a handler with no declaration must read as undeclared.
describe('route walker sanity', () => {
  it('reports a handler with no declaration as null policy', () => {
    class Bare {
      handler(): void {}
    }
    expect(
      readRoutePolicy(new Reflector(), Bare.prototype.handler as never, Bare as never),
    ).toBeNull();
  });
});
