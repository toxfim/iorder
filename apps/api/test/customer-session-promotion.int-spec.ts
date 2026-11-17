import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityModule } from '../src/modules/identity/index.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { PasswordHasher } from '../src/modules/identity/password-hasher.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { FAKE_BOT_TOKEN } from './support/init-data.js';
import { createWorld, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// Found by the security review of the staff viewer work (2026-11-09). A session a CUSTOMER opened
// at the customer site carries no mark of that door. When the same person later became staff, the
// old token answered with their new staff roles: a token kept by the customer site turned into a
// full staff session on every /staff route. Becoming staff now ends the sessions opened before it.
describe('a customer who becomes staff', () => {
  let t: TestApp;
  let w: World;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrdersModule], {
      botToken: FAKE_BOT_TOKEN,
      overrides: [{ token: PasswordHasher, value: new PasswordHasher({ N: 1024, r: 8, p: 1 }) }],
    });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    w = await createWorld(t);
    t.clock.set(new Date(Date.UTC(2026, 9, 21, 9)));
  });

  async function customerSession(): Promise<{ headers: Record<string, string>; id: string }> {
    await t.prisma.staffCredential.create({
      data: {
        userId: w.ids.sellerA,
        scope: 'CUSTOMER',
        login: 'seller-a',
        passwordHash: await t.get(PasswordHasher).hash('customer password 1'),
        passwordChangedAt: t.clock.now(),
      },
    });
    const signIn = await t.request('POST', '/customer/auth/password-login', {
      body: { login: 'seller-a', password: 'customer password 1' },
    });
    expect(signIn.status).toBe(200);
    const session = await t.prisma.staffSession.findFirstOrThrow({
      where: { userId: w.ids.sellerA },
    });
    return {
      headers: { authorization: `Bearer ${(signIn.body as { token: string }).token}` },
      id: session.id,
    };
  }

  async function leaveOrganization(): Promise<void> {
    await t.prisma.organizationMember.updateMany({
      where: { userId: w.ids.sellerA },
      data: { status: 'LEFT', leftAt: t.clock.now() },
    });
  }

  it('loses the session opened as a customer: the old token opens no staff route', async () => {
    // Orders of BOTH organizations exist: a staff session would list them all.
    await submitOrder(w, w.actors.ownerA);
    await submitOrder(w, w.actors.ownerB);
    const session = await customerSession();
    expect((await t.request('GET', '/orders', { headers: session.headers })).status).toBe(200);

    await leaveOrganization();
    await t.get(IdentityService).assignStaffRole(w.actors.admin, w.ids.sellerA, 'MANAGER');

    const row = await t.prisma.staffSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.revokedAt).not.toBeNull();
    for (const path of ['/staff/orders', '/auth/session', '/me', '/orders']) {
      const answer = await t.request('GET', path, { headers: session.headers });
      expect(answer.status, path).toBe(401);
    }
    // History: who ended the sessions and why they ended (hard rule 12).
    const audit = await t.prisma.auditLog.findMany({
      where: { entityId: w.ids.sellerA, action: 'STAFF_SESSIONS_REVOKED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(w.actors.admin.userId);
  });

  it('a further role for someone who is already staff ends nothing', async () => {
    const staffSessions = (): Promise<number> =>
      t.prisma.staffSession.count({ where: { userId: w.ids.manager, revokedAt: null } });
    await t.prisma.staffSession.create({
      data: {
        userId: w.ids.manager,
        tokenHash: 'a'.repeat(64),
        method: 'PASSWORD',
        createdAt: t.clock.now(),
        lastSeenAt: t.clock.now(),
        expiresAt: new Date(t.clock.now().getTime() + 3_600_000),
      },
    });
    expect(await staffSessions()).toBe(1);
    await t.get(IdentityService).assignStaffRole(w.actors.admin, w.ids.manager, 'ACCOUNTANT');
    expect(await staffSessions()).toBe(1);
  });
});
