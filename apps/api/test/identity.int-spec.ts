import {
  meResponseSchema,
  staffUserListResponseSchema,
  staffUserResponseSchema,
  type StaffUserResponse,
} from '@iorder/shared';
import { staffDriverListResponseSchema } from '@iorder/shared/staff-orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
  staffActor,
} from './support/identity-fixtures.js';
import { createTestApp, rejectedByResolver, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';

const error = (body: unknown): { code: string; reason?: string } =>
  (body as { error: { code: string; reason?: string } }).error;

/** The fields a 4xx validation answer names. */
const issuePaths = (body: unknown): string[] =>
  (body as { error: { details: { path: string }[] } }).error.details.map((issue) => issue.path);

describe('identity endpoints (real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, OrganizationsModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetIdentity(t.prisma);
  });

  async function world() {
    const admin = await makeUser(t.prisma, { name: 'Admin', staff: ['ADMIN'] });
    const manager = await makeUser(t.prisma, { name: 'Manager', staff: ['MANAGER'] });
    const org = await makeOrganization(t.prisma, { name: 'Alpha shop' });
    const owner = await makeUser(t.prisma, { name: 'Owner', phone: '+998901112233' });
    await makeMember(t.prisma, org.id, owner.id, 'SHOP_OWNER');
    const customer = await makeUser(t.prisma, { name: 'Customer', phone: '+998905556677' });
    return {
      admin,
      manager,
      org,
      owner,
      customer,
      asAdmin: staffActor(admin.id, 'ADMIN'),
      asManager: staffActor(manager.id, 'MANAGER'),
    };
  }

  const auditRows = () => t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });

  describe('access control', () => {
    it('401 without an actor, 403 for every role that may not edit customers', async () => {
      const w = await world();
      const paths: [string, string][] = [
        ['GET', '/staff/users'],
        ['GET', `/staff/users/${w.customer.id}`],
        ['PATCH', `/staff/users/${w.customer.id}`],
        ['POST', `/staff/users/${w.customer.id}/block`],
        ['POST', `/staff/users/${w.customer.id}/unblock`],
        ['PUT', `/staff/users/${w.customer.id}/roles/DRIVER`],
        ['DELETE', `/staff/users/${w.customer.id}/roles/DRIVER`],
      ];
      for (const [method, path] of paths) {
        expect(
          (
            await t.request(method, path, {
              body: method === 'GET' ? undefined : { fullName: 'x' },
            })
          ).status,
          path,
        ).toBe(401);
        for (const actor of [
          staffActor(w.customer.id, 'DRIVER'),
          staffActor(w.customer.id, 'ACCOUNTANT'),
          staffActor(w.customer.id, 'WAREHOUSE_MANAGER'),
          customerActor(w.owner.id, w.org.id, 'SHOP_OWNER'),
          customerActor(w.customer.id, w.org.id, 'SELLER'),
        ]) {
          expect(
            (
              await t.request(method, path, {
                actor,
                body: method === 'GET' ? undefined : { fullName: 'x' },
              })
            ).status,
          ).toBe(403);
        }
      }
    });

    it('a manager can edit customers but cannot manage staff roles', async () => {
      const w = await world();
      expect(
        (
          await t.request('PATCH', `/staff/users/${w.customer.id}`, {
            actor: w.asManager,
            body: { fullName: 'Renamed' },
          })
        ).status,
      ).toBe(200);
      for (const method of ['PUT', 'DELETE']) {
        expect(
          (
            await t.request(method, `/staff/users/${w.customer.id}/roles/DRIVER`, {
              actor: w.asManager,
            })
          ).status,
        ).toBe(403);
      }
    });

    it('a manager cannot change a person who holds a staff role', async () => {
      const w = await world();
      for (const [method, path, body] of [
        ['PATCH', `/staff/users/${w.admin.id}`, { fullName: 'Hacked' }],
        ['POST', `/staff/users/${w.admin.id}/block`, undefined],
      ] as const) {
        const res = await t.request(method, path, { actor: w.asManager, body });
        expect(res.status, path).toBe(403);
      }
      const unchanged = await t.prisma.user.findUniqueOrThrow({ where: { id: w.admin.id } });
      expect(unchanged.fullName).toBe('Admin');
      expect(unchanged.status).toBe('ACTIVE');
      expect(await auditRows()).toEqual([]);
    });

    it('a manager cannot unblock an administrator, an administrator can block and unblock one', async () => {
      const w = await world();
      const second = await makeUser(t.prisma, { name: 'Second admin', staff: ['ADMIN'] });
      const block = await t.request('POST', `/staff/users/${second.id}/block`, {
        actor: w.asAdmin,
      });
      expect(block.status).toBe(200);
      const denied = await t.request('POST', `/staff/users/${second.id}/unblock`, {
        actor: w.asManager,
      });
      expect(denied.status).toBe(403);
      const still = await t.prisma.user.findUniqueOrThrow({ where: { id: second.id } });
      expect(still.status).toBe('BLOCKED');
      const ok = await t.request('POST', `/staff/users/${second.id}/unblock`, {
        actor: w.asAdmin,
      });
      expect(ok.status).toBe(200);
      const renamed = await t.request('PATCH', `/staff/users/${second.id}`, {
        actor: w.asAdmin,
        body: { fullName: 'Renamed admin' },
      });
      expect(renamed.status).toBe(200);
    });
  });

  describe('reads', () => {
    it('lists and gets users with an explicit DTO (string Telegram id, staff-only phone)', async () => {
      const w = await world();
      const list = await t.request('GET', '/staff/users', { actor: w.asManager });
      expect(list.status).toBe(200);
      const parsed = staffUserListResponseSchema.parse(list.body);
      expect(parsed.items.map((u) => u.fullName)).toEqual([
        'Admin',
        'Customer',
        'Manager',
        'Owner',
      ]);

      const one = await t.request('GET', `/staff/users/${w.owner.id}`, { actor: w.asManager });
      const user = staffUserResponseSchema.parse(one.body);
      expect(user.telegramUserId).toBe(w.owner.telegramUserId.toString());
      expect(typeof (one.body as { telegramUserId: unknown }).telegramUserId).toBe('string');
      expect(user.phone).toBe('+998901112233');
      expect(user.membership).toMatchObject({
        organizationId: w.org.id,
        organizationName: 'Alpha shop',
        role: 'SHOP_OWNER',
      });
      expect(user.staffRoles).toEqual([]);
      expect(findForbiddenKeys(one.body)).toEqual([]);
    });

    it('filters by search (name, phone, Telegram id), status and staff role', async () => {
      const w = await world();
      await t.request('POST', `/staff/users/${w.customer.id}/block`, { actor: w.asAdmin });
      const names = async (query: string) =>
        (
          staffUserListResponseSchema.parse(
            (await t.request('GET', `/staff/users${query}`, { actor: w.asAdmin })).body,
          ).items as StaffUserResponse[]
        ).map((u) => u.fullName);

      expect(await names('?search=owner')).toEqual(['Owner']);
      expect(await names(`?search=${encodeURIComponent('+998905556677')}`)).toEqual(['Customer']);
      expect(await names(`?search=${w.manager.telegramUserId}`)).toEqual(['Manager']);
      expect(await names('?status=BLOCKED')).toEqual(['Customer']);
      expect(await names('?role=MANAGER')).toEqual(['Manager']);
      expect(await names('?search=zzz')).toEqual([]);
    });

    it('treats search wildcards literally', async () => {
      const w = await world();
      const res = await t.request('GET', '/staff/users?search=%25', { actor: w.asAdmin });
      expect(staffUserListResponseSchema.parse(res.body).items).toEqual([]);
    });

    it('404 for an unknown user, 422 for a malformed id or query', async () => {
      const w = await world();
      expect(
        (
          await t.request('GET', '/staff/users/0198c1a0-0000-7000-8000-000000000000', {
            actor: w.asAdmin,
          })
        ).status,
      ).toBe(404);
      expect((await t.request('GET', '/staff/users/not-a-uuid', { actor: w.asAdmin })).status).toBe(
        422,
      );
      expect(
        (await t.request('GET', '/staff/users?status=NOPE', { actor: w.asAdmin })).status,
      ).toBe(422);
      expect((await t.request('GET', '/staff/users?extra=1', { actor: w.asAdmin })).status).toBe(
        422,
      );
    });
  });

  describe('updates are audited with before and after', () => {
    it('updates profile fields and records exactly the changed ones', async () => {
      const w = await world();
      const res = await t.request('PATCH', `/staff/users/${w.customer.id}`, {
        actor: w.asManager,
        body: { fullName: 'New Name', phone: '+998909998877', language: 'RU' },
      });
      expect(res.status).toBe(200);
      expect(staffUserResponseSchema.parse(res.body)).toMatchObject({
        fullName: 'New Name',
        phone: '+998909998877',
        language: 'RU',
      });
      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: w.manager.id,
        entityType: 'USER',
        entityId: w.customer.id,
        action: 'USER_UPDATED',
        diff: {
          fullName: { from: 'Customer', to: 'New Name' },
          phone: { from: '+998905556677', to: '+998909998877' },
          language: { from: 'UZ', to: 'RU' },
        },
      });
      // The Telegram id is never part of the audit diff.
      expect(JSON.stringify(rows[0]?.diff)).not.toContain(w.customer.telegramUserId.toString());
    });

    it('a no-op update changes neither the row nor the audit log', async () => {
      const w = await world();
      const before = await t.prisma.user.findUniqueOrThrow({ where: { id: w.customer.id } });
      const res = await t.request('PATCH', `/staff/users/${w.customer.id}`, {
        actor: w.asAdmin,
        body: { fullName: 'Customer' },
      });
      expect(res.status).toBe(200);
      const after = await t.prisma.user.findUniqueOrThrow({ where: { id: w.customer.id } });
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(await auditRows()).toEqual([]);
    });

    it('can clear a phone number with null', async () => {
      const w = await world();
      const res = await t.request('PATCH', `/staff/users/${w.customer.id}`, {
        actor: w.asAdmin,
        body: { phone: null },
      });
      expect(staffUserResponseSchema.parse(res.body).phone).toBeNull();
    });

    it.each([
      [{ phone: '90 123 45 67' }],
      [{ fullName: '   ' }],
      [{ status: 'BLOCKED' }],
      [{ telegramUserId: '5' }],
      [{ language: 'DE' }],
      [{}],
    ])('422 for the invalid body %j', async (body) => {
      const w = await world();
      const res = await t.request('PATCH', `/staff/users/${w.customer.id}`, {
        actor: w.asAdmin,
        body,
      });
      expect(res.status).toBe(422);
    });

    it('blocks and unblocks, each audited once and idempotent', async () => {
      const w = await world();
      const path = `/staff/users/${w.customer.id}`;
      expect(
        staffUserResponseSchema.parse(
          (await t.request('POST', `${path}/block`, { actor: w.asManager })).body,
        ).status,
      ).toBe('BLOCKED');
      await t.request('POST', `${path}/block`, { actor: w.asManager });
      expect(
        staffUserResponseSchema.parse(
          (await t.request('POST', `${path}/unblock`, { actor: w.asManager })).body,
        ).status,
      ).toBe('ACTIVE');
      const rows = await auditRows();
      expect(rows.map((r) => r.action)).toEqual(['USER_BLOCKED', 'USER_UNBLOCKED']);
      expect(rows[0]?.diff).toEqual({ status: { from: 'ACTIVE', to: 'BLOCKED' } });
    });

    it('rolls the change back when the audit row cannot be written (same transaction)', async () => {
      const w = await world();
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit down'));
      const res = await t.request('PATCH', `/staff/users/${w.customer.id}`, {
        actor: w.asAdmin,
        body: { fullName: 'Should not stick' },
      });
      expect(res.status).toBe(500);
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: w.customer.id } });
      expect(row.fullName).toBe('Customer');
    });
  });

  describe('staff roles', () => {
    it('an admin assigns and removes roles; one person may hold several', async () => {
      const w = await world();
      const path = `/staff/users/${w.customer.id}/roles`;
      const first = await t.request('PUT', `${path}/DRIVER`, { actor: w.asAdmin });
      expect(first.status).toBe(200);
      const second = await t.request('PUT', `${path}/WAREHOUSE_MANAGER`, { actor: w.asAdmin });
      expect(staffUserResponseSchema.parse(second.body).staffRoles).toEqual([
        'WAREHOUSE_MANAGER',
        'DRIVER',
      ]);

      const removed = await t.request('DELETE', `${path}/DRIVER`, { actor: w.asAdmin });
      expect(staffUserResponseSchema.parse(removed.body).staffRoles).toEqual(['WAREHOUSE_MANAGER']);
      const rows = await auditRows();
      expect(rows.map((r) => r.action)).toEqual([
        'USER_STAFF_ROLE_ASSIGNED',
        'USER_STAFF_ROLE_ASSIGNED',
        'USER_STAFF_ROLE_REMOVED',
      ]);
      expect(rows[0]?.diff).toEqual({ staffRoles: { from: [], to: ['DRIVER'] } });
    });

    it('is idempotent and does not enforce a minimum number of roles', async () => {
      const w = await world();
      const path = `/staff/users/${w.manager.id}/roles`;
      expect((await t.request('PUT', `${path}/MANAGER`, { actor: w.asAdmin })).status).toBe(200);
      expect((await t.request('DELETE', `${path}/DRIVER`, { actor: w.asAdmin })).status).toBe(200);
      expect(await auditRows()).toEqual([]);
      // The last role can be removed: that rule is not confirmed, so it is not invented.
      const res = await t.request('DELETE', `${path}/MANAGER`, { actor: w.asAdmin });
      expect(staffUserResponseSchema.parse(res.body).staffRoles).toEqual([]);
    });

    it('409 STAFF_HAS_MEMBERSHIP for a person with an active organization membership', async () => {
      const w = await world();
      const res = await t.request('PUT', `/staff/users/${w.owner.id}/roles/MANAGER`, {
        actor: w.asAdmin,
      });
      expect(res.status).toBe(409);
      expect(error(res.body).reason).toBe('STAFF_HAS_MEMBERSHIP');
      expect(await t.prisma.userRole.count({ where: { userId: w.owner.id } })).toBe(0);
      expect(await auditRows()).toEqual([]);
    });

    it('a former member can become staff', async () => {
      const w = await world();
      await makeMember(t.prisma, w.org.id, w.customer.id, 'SELLER', 'LEFT');
      const res = await t.request('PUT', `/staff/users/${w.customer.id}/roles/DRIVER`, {
        actor: w.asAdmin,
      });
      expect(res.status).toBe(200);
    });

    it('422 for an unknown role, 404 for an unknown user', async () => {
      const w = await world();
      expect(
        (await t.request('PUT', `/staff/users/${w.customer.id}/roles/DEV`, { actor: w.asAdmin }))
          .status,
      ).toBe(422);
      expect(
        (
          await t.request('PUT', '/staff/users/0198c1a0-0000-7000-8000-000000000000/roles/DRIVER', {
            actor: w.asAdmin,
          })
        ).status,
      ).toBe(404);
    });

    it('two simultaneous requests still never produce a staff member', async () => {
      const w = await world();
      const target = await makeUser(t.prisma, { name: 'Contested' });
      const results = await Promise.all([
        t.request('PUT', `/staff/users/${target.id}/roles/MANAGER`, { actor: w.asAdmin }),
        t.request('PUT', `/staff/organizations/${w.org.id}/shop-owner`, {
          actor: w.asAdmin,
          body: { userId: target.id },
        }),
      ]);
      const roles = await t.prisma.userRole.count({ where: { userId: target.id } });
      const active = await t.prisma.organizationMember.count({
        where: { userId: target.id, status: 'ACTIVE' },
      });
      expect(roles + active).toBeLessThanOrEqual(1);
      for (const res of results) expect([200, 409]).toContain(res.status);
    });
  });

  describe('last administrator protection', () => {
    const activeAdmins = () =>
      t.prisma.user.count({ where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } } });

    it('refuses to block or demote the only active admin (409 LAST_ADMIN), self included', async () => {
      const w = await world();
      const block = await t.request('POST', `/staff/users/${w.admin.id}/block`, {
        actor: w.asAdmin,
      });
      expect(block.status).toBe(409);
      expect(error(block.body).reason).toBe('LAST_ADMIN');
      const demote = await t.request('DELETE', `/staff/users/${w.admin.id}/roles/ADMIN`, {
        actor: w.asAdmin,
      });
      expect(demote.status).toBe(409);
      expect(error(demote.body).reason).toBe('LAST_ADMIN');
      expect(await activeAdmins()).toBe(1);
      expect(await auditRows()).toEqual([]);
    });

    it('does not count a blocked admin as a remaining one', async () => {
      const w = await world();
      await makeUser(t.prisma, { name: 'Blocked admin', staff: ['ADMIN'], status: 'BLOCKED' });
      const res = await t.request('POST', `/staff/users/${w.admin.id}/block`, {
        actor: w.asAdmin,
      });
      expect(res.status).toBe(409);
      expect(error(res.body).reason).toBe('LAST_ADMIN');
    });

    it('allows the same actions while another active admin remains, including on oneself', async () => {
      const w = await world();
      const second = await makeUser(t.prisma, { name: 'Second', staff: ['ADMIN'] });
      expect(
        (await t.request('POST', `/staff/users/${second.id}/block`, { actor: w.asAdmin })).status,
      ).toBe(200);
      // second is now blocked, so w.admin is the last one again.
      expect(
        (await t.request('POST', `/staff/users/${w.admin.id}/block`, { actor: w.asAdmin })).status,
      ).toBe(409);
      await t.request('POST', `/staff/users/${second.id}/unblock`, { actor: w.asAdmin });
      expect(
        (
          await t.request('DELETE', `/staff/users/${w.admin.id}/roles/ADMIN`, {
            actor: w.asAdmin,
          })
        ).status,
      ).toBe(200);
      expect(await activeAdmins()).toBe(1);
    });

    it('is not triggered by other roles or by non-admins', async () => {
      const w = await world();
      expect(
        (await t.request('POST', `/staff/users/${w.manager.id}/block`, { actor: w.asAdmin }))
          .status,
      ).toBe(200);
      expect(
        (
          await t.request('DELETE', `/staff/users/${w.manager.id}/roles/MANAGER`, {
            actor: w.asAdmin,
          })
        ).status,
      ).toBe(200);
    });

    it('holds under concurrency: two admins blocking each other never leave zero', async () => {
      for (let round = 0; round < 10; round += 1) {
        await resetIdentity(t.prisma);
        const a = await makeUser(t.prisma, { name: `A${round}`, staff: ['ADMIN'] });
        const b = await makeUser(t.prisma, { name: `B${round}`, staff: ['ADMIN'] });
        const results = await Promise.all([
          t.request('POST', `/staff/users/${b.id}/block`, { actor: staffActor(a.id, 'ADMIN') }),
          t.request('POST', `/staff/users/${a.id}/block`, { actor: staffActor(b.id, 'ADMIN') }),
        ]);
        expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409]);
        expect(await activeAdmins(), `round ${round}`).toBe(1);
      }
    });
  });

  describe('GET /staff/drivers', () => {
    async function drivers() {
      const w = await world();
      const alice = await makeUser(t.prisma, {
        name: 'Alice Driver',
        phone: '+998907770001',
        staff: ['DRIVER'],
      });
      const bob = await makeUser(t.prisma, { name: 'Bob Driver', staff: ['DRIVER'] });
      await makeUser(t.prisma, {
        name: 'Blocked Driver',
        phone: '+998907770003',
        staff: ['DRIVER'],
        status: 'BLOCKED',
      });
      const warehouse = await makeUser(t.prisma, {
        name: 'Warehouse',
        staff: ['WAREHOUSE_MANAGER'],
      });
      return { ...w, alice, bob, warehouse };
    }

    it('401 without an actor', async () => {
      expect((await t.request('GET', '/staff/drivers')).status).toBe(401);
    });

    it('200 for warehouse manager, manager and admin; the same active drivers only', async () => {
      const w = await drivers();
      for (const actor of [
        staffActor(w.warehouse.id, 'WAREHOUSE_MANAGER'),
        w.asManager,
        w.asAdmin,
      ]) {
        const res = await t.request('GET', '/staff/drivers', { actor });
        expect(res.status).toBe(200);
        expect(staffDriverListResponseSchema.parse(res.body)).toEqual({
          items: [
            { id: w.alice.id, fullName: 'Alice Driver' },
            { id: w.bob.id, fullName: 'Bob Driver' },
          ],
        });
      }
    });

    it('403 for accountant, driver and both customer roles', async () => {
      const w = await drivers();
      for (const actor of [
        staffActor(w.customer.id, 'ACCOUNTANT'),
        staffActor(w.alice.id, 'DRIVER'),
        customerActor(w.owner.id, w.org.id, 'SHOP_OWNER'),
        customerActor(w.customer.id, w.org.id, 'SELLER'),
      ]) {
        expect((await t.request('GET', '/staff/drivers', { actor })).status).toBe(403);
      }
    });

    it('excludes blocked users and non-drivers, and leaks no phone or Telegram id', async () => {
      const w = await drivers();
      const res = await t.request('GET', '/staff/drivers', {
        actor: staffActor(w.warehouse.id, 'WAREHOUSE_MANAGER'),
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('Blocked Driver');
      expect(text).not.toContain('Warehouse');
      expect(text).not.toContain('Manager');
      expect(text).not.toContain('998907770001');
      expect(text).not.toContain(w.alice.telegramUserId.toString());
      for (const item of (res.body as { items: object[] }).items) {
        expect(Object.keys(item).sort()).toEqual(['fullName', 'id']);
      }
    });
  });

  describe('GET /me', () => {
    it('401 without an actor', async () => {
      expect((await t.request('GET', '/me')).status).toBe(401);
    });

    it('returns the summary of every kind of caller, from the actor and never from the URL', async () => {
      const w = await world();
      const asOwner = await t.request('GET', '/me', {
        actor: customerActor(w.owner.id, w.org.id, 'SHOP_OWNER'),
      });
      expect(meResponseSchema.parse(asOwner.body)).toEqual({
        userId: w.owner.id,
        fullName: 'Owner',
        locale: 'UZ',
        staffRoles: [],
        membership: {
          organizationId: w.org.id,
          organizationName: 'Alpha shop',
          role: 'SHOP_OWNER',
        },
        contact: { fullName: 'Owner', phone: '+998901112233' },
        needsContact: false,
        // A customer is never a staff viewer of the customer app.
        staffViewer: null,
      });

      for (const role of [
        'ADMIN',
        'MANAGER',
        'ACCOUNTANT',
        'WAREHOUSE_MANAGER',
        'DRIVER',
      ] as const) {
        const person = await makeUser(t.prisma, { name: role, staff: [role] });
        const res = await t.request('GET', '/me', { actor: staffActor(person.id, role) });
        expect(meResponseSchema.parse(res.body)).toMatchObject({
          staffRoles: [role],
          membership: null,
          contact: null,
          needsContact: false,
          // What the person is in the customer app ([C] 2026-11-09): a viewer who cannot order
          // (no organization is configured for staff orders here), or, for the roles that never
          // see a price, nobody.
          staffViewer:
            role === 'WAREHOUSE_MANAGER' || role === 'DRIVER'
              ? null
              : { canOrder: false, organizationName: null },
        });
      }
    });

    it('needsContact is true for a customer without a phone', async () => {
      const w = await world();
      const fresh = await makeUser(t.prisma, { name: 'Fresh' });
      await makeMember(t.prisma, w.org.id, fresh.id, 'SELLER');
      const res = await t.request('GET', '/me', {
        actor: customerActor(fresh.id, w.org.id, 'SELLER'),
      });
      expect(meResponseSchema.parse(res.body)).toMatchObject({ contact: null, needsContact: true });
    });

    it('shows only the caller own phone and never a Telegram id or a colleague phone', async () => {
      const w = await world();
      const res = await t.request('GET', '/me', {
        actor: customerActor(w.owner.id, w.org.id, 'SHOP_OWNER'),
      });
      const text = JSON.stringify(res.body);
      expect(text).toContain('998901112233');
      expect(text).not.toContain('998905556677');
      expect(text).not.toContain(w.owner.telegramUserId.toString());
      expect(Object.keys(res.body as object)).not.toContain('phone');
      expect(Object.keys(res.body as object)).not.toContain('telegramUserId');
    });

    it('drops a membership that a buggy actor carries next to a staff role', async () => {
      const w = await world();
      const res = await t.request('GET', '/me', {
        actor: {
          userId: w.admin.id,
          staffRoles: ['ADMIN'],
          membership: { organizationId: w.org.id, role: 'SELLER' },
        },
      });
      expect(meResponseSchema.parse(res.body).membership).toBeNull();
    });
  });

  describe('PUT /me/contact', () => {
    const body = { fullName: '  Ali Valiyev ', phone: '+998 93 555 0147' };

    async function freshCustomer() {
      const w = await world();
      const fresh = await makeUser(t.prisma, { name: 'Telegram Name' });
      await makeMember(t.prisma, w.org.id, fresh.id, 'SELLER');
      return { w, fresh, actor: customerActor(fresh.id, w.org.id, 'SELLER') };
    }

    it('401 without an actor, 403 for staff and for a person without a membership', async () => {
      const w = await world();
      expect((await t.request('PUT', '/me/contact', { body })).status).toBe(401);
      for (const role of [
        'ADMIN',
        'MANAGER',
        'ACCOUNTANT',
        'WAREHOUSE_MANAGER',
        'DRIVER',
      ] as const) {
        const res = await t.request('PUT', '/me/contact', {
          actor: staffActor(w.admin.id, role),
          body,
        });
        expect(res.status, role).toBe(403);
      }
      const loner = await makeUser(t.prisma, { name: 'Loner' });
      const res = await t.request('PUT', '/me/contact', {
        actor: { userId: loner.id, staffRoles: [] },
        body,
      });
      expect(res.status).toBe(403);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: loner.id } })).phone).toBeNull();
    });

    it('sets name and phone the first time, normalised, with one audit row by the customer', async () => {
      const { fresh, actor } = await freshCustomer();
      const res = await t.request('PUT', '/me/contact', { actor, body });
      expect(res.status).toBe(200);
      expect(meResponseSchema.parse(res.body)).toMatchObject({
        fullName: 'Ali Valiyev',
        contact: { fullName: 'Ali Valiyev', phone: '+998935550147' },
        needsContact: false,
      });
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } });
      expect([row.fullName, row.phone]).toEqual(['Ali Valiyev', '+998935550147']);
      const audits = (await auditRows()).filter((a) => a.action === 'USER_CONTACT_SET');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorUserId: fresh.id, entityId: fresh.id });
      expect(audits[0]?.diff).toEqual({
        fullName: { from: 'Telegram Name', to: 'Ali Valiyev' },
        phone: { from: null, to: '+998935550147' },
      });
    });

    it('the same values again are a no-op; other values change the contact, each change audited', async () => {
      const { fresh, actor } = await freshCustomer();
      await t.request('PUT', '/me/contact', { actor, body });
      const again = await t.request('PUT', '/me/contact', { actor, body });
      expect(again.status).toBe(200);
      expect(await auditRows()).toHaveLength(1);

      const renamed = await t.request('PUT', '/me/contact', {
        actor,
        body: { fullName: 'Ali Valiyev', phone: '+998 90 123 45 67' },
      });
      expect(renamed.status).toBe(200);
      expect(meResponseSchema.parse(renamed.body)).toMatchObject({
        fullName: 'Ali Valiyev',
        contact: { fullName: 'Ali Valiyev', phone: '+998901234567' },
        needsContact: false,
      });
      const second = await t.request('PUT', '/me/contact', {
        actor,
        body: { fullName: 'Alisher Valiyev', phone: '+998901234567' },
      });
      expect(second.status).toBe(200);

      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } });
      expect([row.fullName, row.phone]).toEqual(['Alisher Valiyev', '+998901234567']);
      const audits = await auditRows();
      expect(audits.map((a) => a.action)).toEqual([
        'USER_CONTACT_SET',
        'USER_OWN_PROFILE_UPDATED',
        'USER_OWN_PROFILE_UPDATED',
      ]);
      for (const audit of audits) {
        expect(audit).toMatchObject({ actorUserId: fresh.id, entityId: fresh.id });
      }
      // Only what changed, from what to what; the first row still says what it recorded.
      expect(audits[0]?.diff).toEqual({
        fullName: { from: 'Telegram Name', to: 'Ali Valiyev' },
        phone: { from: null, to: '+998935550147' },
      });
      expect(audits[1]?.diff).toEqual({ phone: { from: '+998935550147', to: '+998901234567' } });
      expect(audits[2]?.diff).toEqual({
        fullName: { from: 'Ali Valiyev', to: 'Alisher Valiyev' },
      });
    });

    it('a customer whose contact came from staff changes it the same way', async () => {
      const w = await world();
      const actor = customerActor(w.owner.id, w.org.id, 'SHOP_OWNER');
      const res = await t.request('PUT', '/me/contact', {
        actor,
        body: { fullName: 'Owner Renamed', phone: '+998901112233' },
      });
      expect(res.status).toBe(200);
      const audits = await auditRows();
      expect(audits.map((a) => a.action)).toEqual(['USER_OWN_PROFILE_UPDATED']);
      expect(audits[0]?.diff).toEqual({ fullName: { from: 'Owner', to: 'Owner Renamed' } });
    });

    it('changes only the caller: no other person, role, membership or Telegram id moves', async () => {
      const w = await world();
      const actor = customerActor(w.owner.id, w.org.id, 'SHOP_OWNER');
      const people = () =>
        t.prisma.user.findMany({ orderBy: { id: 'asc' }, include: { roles: true } });
      const members = () => t.prisma.organizationMember.findMany({ orderBy: { userId: 'asc' } });
      const before = await people();
      const membersBefore = await members();
      await t.request('PUT', '/me/contact', {
        actor,
        body: { fullName: 'Owner Renamed', phone: '+998909990011' },
      });
      const after = await people();
      for (const [index, row] of after.entries()) {
        const old = before[index];
        if (row.id === w.owner.id) {
          expect(row).toEqual({
            ...old,
            fullName: 'Owner Renamed',
            phone: '+998909990011',
            updatedAt: row.updatedAt,
          });
        } else {
          expect(row).toEqual(old);
        }
      }
      expect(await members()).toEqual(membersBefore);
    });

    it('staff can still correct the phone through the staff edit', async () => {
      const { fresh, w, actor } = await freshCustomer();
      await t.request('PUT', '/me/contact', { actor, body });
      const res = await t.request('PATCH', `/staff/users/${fresh.id}`, {
        actor: w.asManager,
        body: { phone: '+998901234567' },
      });
      expect(res.status).toBe(200);
    });

    it('rejects a bad phone, a bad name or unknown keys, names the field, and writes nothing', async () => {
      const { fresh, actor } = await freshCustomer();
      const ok = { fullName: 'Ali', phone: '+998935550147' };
      for (const [bad, field] of [
        [{ ...ok, phone: '12345' }, 'phone'],
        [{ ...ok, fullName: '  ' }, 'fullName'],
        [{ ...ok, fullName: 'Ali\u202EValiyev' }, 'fullName'],
        [{ fullName: 'Ali' }, 'phone'],
        [{ ...ok, phone: null }, 'phone'],
        // Nothing but the two fields is accepted: no id, role, membership, login or Telegram id.
        [{ ...ok, userId: fresh.id }, null],
        [{ ...ok, staffRoles: ['ADMIN'] }, null],
        [{ ...ok, telegramUserId: '1' }, null],
        [{ ...ok, organizationId: fresh.id }, null],
        [{ ...ok, status: 'ACTIVE' }, null],
      ] as const) {
        const res = await t.request('PUT', '/me/contact', { actor, body: bad });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(error(res.body).code).toBe('VALIDATION_FAILED');
        if (field !== null) expect(issuePaths(res.body), JSON.stringify(bad)).toContain(field);
      }
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } })).phone).toBeNull();
      expect(await auditRows()).toEqual([]);
    });

    it('two parallel different contacts: both are applied in turn, the later one stays', async () => {
      const { fresh, actor } = await freshCustomer();
      const first = { fullName: 'Ali Valiyev', phone: '+998935550147' };
      const second = { fullName: 'Vali Aliyev', phone: '+998901234567' };
      const results = await Promise.all([
        t.request('PUT', '/me/contact', { actor, body: first }),
        t.request('PUT', '/me/contact', { actor, body: second }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      // The row lock serializes them: one audit row per change, each starting where the other ended.
      const audits = await auditRows();
      expect(audits.map((a) => a.action)).toEqual(['USER_CONTACT_SET', 'USER_OWN_PROFILE_UPDATED']);
      const [earlier, later] = audits.map(
        (a) => a.diff as Record<'fullName' | 'phone', { from: string | null; to: string }>,
      );
      expect(later?.phone.from).toBe(earlier?.phone.to);
      expect(later?.fullName.from).toBe(earlier?.fullName.to);
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } });
      expect([row.fullName, row.phone]).toEqual([later?.fullName.to, later?.phone.to]);
    });

    it('a blocked customer is turned away (401) and nothing is written', async () => {
      const { fresh, actor } = await freshCustomer();
      await t.prisma.user.update({ where: { id: fresh.id }, data: { status: 'BLOCKED' } });
      const res = await t.request('PUT', '/me/contact', {
        actor: rejectedByResolver(actor, 'BLOCKED'),
        body,
      });
      expect(res.status).toBe(401);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } })).phone).toBeNull();
      expect((await auditRows()).filter((a) => a.action === 'USER_CONTACT_SET')).toEqual([]);
    });

    it('a block that lands after the request was authenticated still wins (403, nothing written)', async () => {
      const { fresh, actor } = await freshCustomer();
      await t.prisma.user.update({ where: { id: fresh.id }, data: { status: 'BLOCKED' } });
      // The actor is still the one resolved before the block: the service re-checks under the lock.
      const res = await t.request('PUT', '/me/contact', { actor, body });
      expect(res.status).toBe(403);
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: fresh.id } });
      expect([row.fullName, row.phone]).toEqual(['Telegram Name', null]);
      expect(await auditRows()).toEqual([]);
    });

    it('a customer whose membership is LEFT has no access (403) and nothing is written', async () => {
      const w = await world();
      const former = await makeUser(t.prisma, { name: 'Former' });
      await makeMember(t.prisma, w.org.id, former.id, 'SELLER', 'LEFT');
      // The production resolver gives a LEFT member an actor without any membership.
      const res = await t.request('PUT', '/me/contact', {
        actor: { userId: former.id, staffRoles: [] },
        body,
      });
      expect(res.status).toBe(403);
      expect(
        (await t.prisma.user.findUniqueOrThrow({ where: { id: former.id } })).phone,
      ).toBeNull();
      expect((await auditRows()).filter((a) => a.action === 'USER_CONTACT_SET')).toEqual([]);
    });

    it('is rate limited per actor (429)', async () => {
      const { actor } = await freshCustomer();
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        last = (
          await t.request('PUT', '/me/contact', {
            actor,
            body: { fullName: 'A', phone: '+998935550147' },
          })
        ).status;
      }
      expect(last).toBe(429);
    });
  });

  describe('customers never reach other organizations', () => {
    it('a customer of organization A gets 403 on every user and organization endpoint', async () => {
      const w = await world();
      const otherOrg = await makeOrganization(t.prisma, { name: 'Beta shop' });
      const other = await makeUser(t.prisma, { name: 'Beta owner', phone: '+998907776655' });
      await makeMember(t.prisma, otherOrg.id, other.id, 'SHOP_OWNER');

      const asAlphaOwner = customerActor(w.owner.id, w.org.id, 'SHOP_OWNER');
      const asAlphaSeller = customerActor(w.customer.id, w.org.id, 'SELLER');
      for (const actor of [asAlphaOwner, asAlphaSeller]) {
        for (const path of [
          '/staff/users',
          `/staff/users/${other.id}`,
          '/staff/organizations',
          `/staff/organizations/${otherOrg.id}`,
        ]) {
          const res = await t.request('GET', path, { actor });
          expect(res.status, path).toBe(403);
          expect(JSON.stringify(res.body)).not.toContain('Beta');
          expect(JSON.stringify(res.body)).not.toContain('998907776655');
        }
        // Not even a probing request against another organization's id reveals if it exists.
        const probe = await t.request(
          'GET',
          '/staff/organizations/0198c1a0-0000-7000-8000-000000000000',
          { actor },
        );
        expect(probe.status).toBe(403);
      }
    });
  });
});
