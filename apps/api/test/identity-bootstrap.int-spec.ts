import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityModule, IdentityService } from '../src/modules/identity/index.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

const DEVELOPER_ID = 4_242_424_242n;

describe('admin bootstrap (seed:admin) against a real database', () => {
  let t: TestApp;
  let identity: IdentityService;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule]);
    await t.prisma.$connect();
    identity = t.get(IdentityService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetIdentity(t.prisma);
  });

  const audit = () => t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });

  it('creates an ACTIVE user with the ADMIN role, audited as a system action', async () => {
    const result = await identity.bootstrapAdmin(DEVELOPER_ID);
    expect(result).toEqual({ userCreated: true, roleAdded: true });

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { telegramUserId: DEVELOPER_ID },
      include: { roles: true },
    });
    expect(user.status).toBe('ACTIVE');
    expect(user.roles.map((r) => r.role)).toEqual(['ADMIN']);

    const rows = await audit();
    expect(rows.map((r) => [r.actorUserId, r.action, r.entityId])).toEqual([
      [null, 'BOOTSTRAP_USER_CREATED', user.id],
      [null, 'BOOTSTRAP_ADMIN_ENSURED', user.id],
    ]);
    // The Telegram id is never written to the audit log.
    expect(JSON.stringify(rows.map((r) => r.diff))).not.toContain(DEVELOPER_ID.toString());
  });

  it('is idempotent: a second run changes and records nothing', async () => {
    await identity.bootstrapAdmin(DEVELOPER_ID);
    const before = await audit();
    const result = await identity.bootstrapAdmin(DEVELOPER_ID);
    expect(result).toEqual({ userCreated: false, roleAdded: false });
    expect(await audit()).toHaveLength(before.length);
    expect(await t.prisma.userRole.count()).toBe(1);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('gives ADMIN to an existing user without touching their profile', async () => {
    const existing = await makeUser(t.prisma, {
      name: 'Dev Person',
      phone: '+998901234567',
      telegramUserId: DEVELOPER_ID,
      staff: ['MANAGER'],
    });
    const result = await identity.bootstrapAdmin(DEVELOPER_ID);
    expect(result).toEqual({ userCreated: false, roleAdded: true });
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
      include: { roles: true },
    });
    expect(user.fullName).toBe('Dev Person');
    expect(user.phone).toBe('+998901234567');
    expect(user.roles.map((r) => r.role).sort()).toEqual(['ADMIN', 'MANAGER']);
    expect((await audit()).map((r) => r.action)).toEqual(['BOOTSTRAP_ADMIN_ENSURED']);
  });

  it('does NOT reactivate a blocked user (409 USER_BLOCKED) and changes nothing', async () => {
    await makeUser(t.prisma, { telegramUserId: DEVELOPER_ID, status: 'BLOCKED' });
    await expect(identity.bootstrapAdmin(DEVELOPER_ID)).rejects.toMatchObject({
      reason: 'USER_BLOCKED',
    });
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { telegramUserId: DEVELOPER_ID },
      include: { roles: true },
    });
    expect(user.status).toBe('BLOCKED');
    expect(user.roles).toEqual([]);
    expect(await audit()).toEqual([]);
  });

  it('refuses a person with an active organization membership and changes nothing', async () => {
    const org = await makeOrganization(t.prisma);
    const member = await makeUser(t.prisma, { telegramUserId: DEVELOPER_ID });
    await makeMember(t.prisma, org.id, member.id);
    await expect(identity.bootstrapAdmin(DEVELOPER_ID)).rejects.toMatchObject({
      reason: 'STAFF_HAS_MEMBERSHIP',
    });
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: member.id },
      include: { roles: true },
    });
    expect(user.roles).toEqual([]);
    expect(user.status).toBe('ACTIVE');
    expect(await audit()).toEqual([]);
  });

  it('survives concurrent runs: one user, one role', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => identity.bootstrapAdmin(DEVELOPER_ID)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await t.prisma.user.count()).toBe(1);
    expect(await t.prisma.userRole.count()).toBe(1);
  });
});
