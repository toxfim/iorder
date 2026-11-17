import {
  Controller,
  Get,
  Module,
  Post,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter.js';
import type { Actor } from './actor.js';
import { ActorResolver } from './actor-resolver.js';
import { PermissionGuard } from './permission.guard.js';
import { APP_ENV } from '../../config/config.module.js';
import { CurrentActor, CustomerArea, Public, RequirePermission } from './route-access.js';

@Controller('guarded')
class GuardedController {
  @Get('prices')
  @RequirePermission('BROWSE_PRICE_LIST')
  prices(@CurrentActor() actor: Actor): { userId: string } {
    return { userId: actor.userId };
  }

  @Post('staff')
  @RequirePermission('MANAGE_STAFF')
  staff(): { ok: true } {
    return { ok: true };
  }
}

// Class-level declaration, with one method overriding it and one opting out.
@Controller('classlevel')
@RequirePermission('MANAGE_STAFF')
class ClassLevelController {
  @Get('inherited')
  inherited(): { ok: true } {
    return { ok: true };
  }

  @Get('overridden')
  @RequirePermission('BROWSE_PRICE_LIST')
  overridden(): { ok: true } {
    return { ok: true };
  }

  @Get('open')
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }
}

@Public()
@Controller('publicclass')
class PublicClassController {
  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }

  @Get('restricted')
  @RequirePermission('MANAGE_STAFF')
  restricted(): { ok: true } {
    return { ok: true };
  }
}

// A customer-area controller: a staff member reaches it only as the staff viewer.
@Controller('customer-area')
@CustomerArea()
class CustomerAreaController {
  @Get('cart')
  @RequirePermission('USE_CART')
  cart(@CurrentActor() actor: Actor): Actor {
    return actor;
  }

  // A staff action on a customer-area route: the viewer holds no staff grant, so nobody passes.
  @Get('staff-action')
  @RequirePermission('MANAGE_STAFF')
  staffAction(): { ok: true } {
    return { ok: true };
  }
}

// The marker on one method only: the rest of the controller keeps the staff actor.
@Controller('mixed-area')
class MixedAreaController {
  @Get('prices')
  @CustomerArea()
  @RequirePermission('BROWSE_PRICE_LIST')
  prices(@CurrentActor() actor: Actor): Actor {
    return actor;
  }

  @Get('staff-prices')
  @RequirePermission('BROWSE_PRICE_LIST')
  staffPrices(@CurrentActor() actor: Actor): Actor {
    return actor;
  }
}

// Declares nothing: must be denied by the global guard.
@Controller('undeclared')
class UndeclaredController {
  @Get()
  open(): { ok: true } {
    return { ok: true };
  }
}

// Test-only resolver: the header "x-test-roles" stands in for real authentication.
class HeaderResolver extends ActorResolver {
  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    if (request.headers['x-test-throw'] !== undefined)
      throw new Error('resolver exploded: secret-token');
    const roles = request.headers['x-test-roles'];
    if (roles === undefined) return null;
    const staffRoles = roles === '' ? [] : (roles.split(',') as Actor['staffRoles'][number][]);
    return { userId: 'u-1', staffRoles };
  }
}

async function start(
  withResolver: boolean,
  staffOrderingOrganizationId?: string,
): Promise<{ app: INestApplication; baseUrl: string }> {
  @Module({
    controllers: [
      GuardedController,
      ClassLevelController,
      PublicClassController,
      CustomerAreaController,
      MixedAreaController,
      UndeclaredController,
    ],
    providers: [
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_GUARD, useClass: PermissionGuard },
      ...(withResolver ? [{ provide: ActorResolver, useClass: HeaderResolver }] : []),
      ...(staffOrderingOrganizationId === undefined
        ? []
        : [
            {
              provide: APP_ENV,
              useValue: { STAFF_ORDERING_ORGANIZATION_ID: staffOrderingOrganizationId },
            },
          ]),
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { app, baseUrl };
}

describe('PermissionGuard with a resolver', () => {
  let app: INestApplication;
  let baseUrl: string;

  const get = (path: string, roles?: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: roles === undefined ? {} : { 'x-test-roles': roles },
    });

  beforeAll(async () => {
    ({ app, baseUrl } = await start(true));
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns 401 when the resolver returns null', async () => {
    const response = await get('/guarded/prices');
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('never allows when the resolver throws, and hides the cause', async () => {
    const response = await fetch(`${baseUrl}/guarded/prices`, {
      headers: { 'x-test-throw': '1', 'x-test-roles': 'ADMIN' },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret-token');
  });

  it('returns 403 for an authenticated actor without a role for the action', async () => {
    expect((await get('/guarded/prices', 'DRIVER')).status).toBe(403);
  });

  it('never allows an actor with no roles', async () => {
    expect((await get('/guarded/prices', '')).status).toBe(403);
    expect((await get('/classlevel/open', '')).status).toBe(200);
    expect((await get('/classlevel/inherited', '')).status).toBe(403);
  });

  it('lets an allowed role through and exposes the actor to the handler', async () => {
    const response = await get('/guarded/prices', 'ACCOUNTANT');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'u-1' });
  });

  it('enforces the declared action per route', async () => {
    expect((await get('/guarded/staff', 'MANAGER', { method: 'POST' })).status).toBe(403);
    expect((await get('/guarded/staff', 'ADMIN', { method: 'POST' })).status).toBe(201);
  });

  it('denies a route that declares nothing, even for admin', async () => {
    expect((await get('/undeclared', 'ADMIN')).status).toBe(403);
    expect((await get('/undeclared')).status).toBe(403);
  });

  describe('class-level declarations', () => {
    it('apply to methods without their own declaration', async () => {
      expect((await get('/classlevel/inherited', 'MANAGER')).status).toBe(403);
      expect((await get('/classlevel/inherited', 'ADMIN')).status).toBe(200);
      expect((await get('/classlevel/inherited')).status).toBe(401);
    });

    it('are overridden by a method-level @RequirePermission', async () => {
      expect((await get('/classlevel/overridden', 'MANAGER')).status).toBe(200);
      expect((await get('/classlevel/overridden', 'DRIVER')).status).toBe(403);
    });

    it('are overridden by a method-level @Public', async () => {
      expect((await get('/classlevel/open')).status).toBe(200);
    });

    it('a class-level @Public still lets a method require a permission', async () => {
      expect((await get('/publicclass/plain')).status).toBe(200);
      expect((await get('/publicclass/restricted')).status).toBe(401);
      expect((await get('/publicclass/restricted', 'MANAGER')).status).toBe(403);
      expect((await get('/publicclass/restricted', 'ADMIN')).status).toBe(200);
    });
  });
});

describe('PermissionGuard without any ActorResolver registered', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await start(false));
  });
  afterAll(async () => {
    await app.close();
  });

  it('rejects every non-public request with 401, even one that looks privileged', async () => {
    const response = await fetch(`${baseUrl}/guarded/prices`, {
      headers: { 'x-test-roles': 'ADMIN' },
    });
    expect(response.status).toBe(401);
  });

  it('still serves @Public routes', async () => {
    expect((await fetch(`${baseUrl}/classlevel/open`)).status).toBe(200);
  });
});

describe('PermissionGuard on customer-area routes ([C] 2026-11-09)', () => {
  const ORDERING_ORG = '0198c0de-0000-7000-8000-000000000001';
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await start(true, ORDERING_ORG));
  });
  afterAll(async () => {
    await app.close();
  });

  const call = async (path: string, roles: string): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { 'x-test-roles': roles } });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it('hands the handler the staff viewer, never the staff actor', async () => {
    const reply = await call('/customer-area/cart', 'MANAGER,DRIVER');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['MANAGER', 'DRIVER'], orderingOrganizationId: ORDERING_ORG },
    });
  });

  it('refuses staff whose roles do not open the customer app', async () => {
    expect((await call('/customer-area/cart', 'DRIVER')).status).toBe(403);
    expect((await call('/customer-area/cart', 'WAREHOUSE_MANAGER')).status).toBe(403);
  });

  it('never lets a staff grant through on a customer-area route, even for the admin', async () => {
    expect((await call('/customer-area/staff-action', 'ADMIN')).status).toBe(403);
    // The same action outside the customer area still works for the admin.
    const response = await fetch(`${baseUrl}/guarded/staff`, {
      method: 'POST',
      headers: { 'x-test-roles': 'ADMIN' },
    });
    expect(response.status).toBe(201);
  });

  it('a method-level marker covers that method only', async () => {
    const viewed = await call('/mixed-area/prices', 'ACCOUNTANT');
    expect(viewed.body).toMatchObject({
      staffRoles: [],
      staffViewer: { staffRoles: ['ACCOUNTANT'] },
    });
    const staff = await call('/mixed-area/staff-prices', 'ACCOUNTANT');
    expect(staff.body).toEqual({ userId: 'u-1', staffRoles: ['ACCOUNTANT'] });
  });

  it('an actor without roles is not turned into a viewer', async () => {
    expect((await call('/customer-area/cart', '')).status).toBe(403);
  });
});

describe('PermissionGuard on customer-area routes without the staff ordering setting', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await start(true));
  });
  afterAll(async () => {
    await app.close();
  });

  it('builds a viewer that can order nowhere', async () => {
    const response = await fetch(`${baseUrl}/customer-area/cart`, {
      headers: { 'x-test-roles': 'MANAGER' },
    });
    expect(await response.json()).toEqual({
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['MANAGER'], orderingOrganizationId: null },
    });
  });
});
