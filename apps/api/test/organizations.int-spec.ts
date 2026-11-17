import {
  staffOrganizationListResponseSchema,
  staffOrganizationResponseSchema,
  type StaffOrganizationResponse,
} from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/index.js';
import { IdentityModule } from '../src/modules/identity/index.js';
import { OrganizationsModule } from '../src/modules/organizations/index.js';
import { findForbiddenKeys } from './support/forbidden-fields.js';
import {
  customerActor,
  makeMember,
  makeOrganization,
  makeUser,
  staffActor,
} from './support/identity-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { resetIdentity } from './support/test-db.js';

const reason = (body: unknown): string | undefined =>
  (body as { error: { reason?: string } }).error.reason;

describe('organization endpoints (real PostgreSQL)', () => {
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
    t.clock.set(new Date('2026-10-20T08:00:00Z'));
    await resetIdentity(t.prisma);
  });

  async function world() {
    const admin = await makeUser(t.prisma, { name: 'Admin', staff: ['ADMIN'] });
    const manager = await makeUser(t.prisma, { name: 'Manager', staff: ['MANAGER'] });
    const org = await makeOrganization(t.prisma, { name: 'Alpha shop' });
    const owner = await makeUser(t.prisma, { name: 'Owner', phone: '+998901112233' });
    const seller = await makeUser(t.prisma, { name: 'Seller', phone: '+998904445566' });
    await makeMember(t.prisma, org.id, owner.id, 'SHOP_OWNER');
    await makeMember(t.prisma, org.id, seller.id, 'SELLER');
    return {
      org,
      owner,
      seller,
      manager,
      asAdmin: staffActor(admin.id, 'ADMIN'),
      asManager: staffActor(manager.id, 'MANAGER'),
      adminId: admin.id,
    };
  }

  const detail = (body: unknown): StaffOrganizationResponse =>
    staffOrganizationResponseSchema.parse(body);
  const auditRows = () => t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
  const orgPath = (id: string, tail = '') => `/staff/organizations/${id}${tail}`;

  describe('access control', () => {
    it('401 without an actor, 403 for roles that may not edit customers', async () => {
      const w = await world();
      const calls: [string, string, unknown][] = [
        ['GET', '/staff/organizations', undefined],
        ['GET', orgPath(w.org.id), undefined],
        ['PATCH', orgPath(w.org.id), { name: 'x' }],
        ['PUT', orgPath(w.org.id, '/shop-owner'), { userId: w.seller.id }],
        ['DELETE', orgPath(w.org.id, '/shop-owner'), undefined],
        ['PATCH', orgPath(w.org.id, `/members/${w.seller.id}`), { role: 'SHOP_OWNER' }],
        ['POST', orgPath(w.org.id, `/members/${w.seller.id}/leave`), undefined],
      ];
      for (const [method, path, body] of calls) {
        expect((await t.request(method, path, { body })).status, path).toBe(401);
        for (const actor of [
          staffActor(w.seller.id, 'DRIVER'),
          staffActor(w.seller.id, 'ACCOUNTANT'),
          staffActor(w.seller.id, 'WAREHOUSE_MANAGER'),
          customerActor(w.owner.id, w.org.id, 'SHOP_OWNER'),
          customerActor(w.seller.id, w.org.id, 'SELLER'),
        ]) {
          expect((await t.request(method, path, { actor, body })).status, path).toBe(403);
        }
      }
      expect(await auditRows()).toEqual([]);
    });

    it('manager and admin are allowed', async () => {
      const w = await world();
      for (const actor of [w.asManager, w.asAdmin]) {
        expect((await t.request('GET', orgPath(w.org.id), { actor })).status).toBe(200);
      }
    });
  });

  describe('reads', () => {
    it('lists summaries and gets detail with members, using explicit DTOs', async () => {
      const w = await world();
      await makeMember(
        t.prisma,
        (await makeOrganization(t.prisma, { name: 'Beta shop', status: 'INACTIVE' })).id,
        (await makeUser(t.prisma, { name: 'Other' })).id,
      );

      const list = staffOrganizationListResponseSchema.parse(
        (await t.request('GET', '/staff/organizations', { actor: w.asManager })).body,
      );
      expect(list.items.map((o) => o.name)).toEqual(['Alpha shop', 'Beta shop']);
      expect(list.items[0]).toMatchObject({
        activeMemberCount: 2,
        shopOwner: { userId: w.owner.id, fullName: 'Owner' },
        pricePostingEnabled: false,
        status: 'ACTIVE',
      });
      expect(list.items[0]).not.toHaveProperty('members');
      expect(list.items[1]).toMatchObject({ status: 'INACTIVE', shopOwner: null });

      const res = await t.request('GET', orgPath(w.org.id), { actor: w.asManager });
      const org = detail(res.body);
      expect(org.members.map((m) => [m.fullName, m.role, m.status])).toEqual([
        ['Owner', 'SHOP_OWNER', 'ACTIVE'],
        ['Seller', 'SELLER', 'ACTIVE'],
      ]);
      expect(org.members[0]?.phone).toBe('+998901112233');
      // The negative group id travels as a string.
      expect(typeof (res.body as { telegramChatId: unknown }).telegramChatId).toBe('string');
      expect(String(org.telegramChatId).startsWith('-100')).toBe(true);
      expect(findForbiddenKeys(res.body)).toEqual([]);
    });

    it('filters by search and status; wildcards are literal', async () => {
      const w = await world();
      await makeOrganization(t.prisma, { name: 'Beta shop', status: 'INACTIVE' });
      const names = async (query: string) =>
        staffOrganizationListResponseSchema
          .parse(
            (await t.request('GET', `/staff/organizations${query}`, { actor: w.asAdmin })).body,
          )
          .items.map((o) => o.name);
      expect(await names('?search=alp')).toEqual(['Alpha shop']);
      expect(await names('?status=INACTIVE')).toEqual(['Beta shop']);
      expect(await names('?search=%25')).toEqual([]);
      expect(await names('?search=_lpha')).toEqual([]);
    });

    it('404 for an unknown organization, 422 for a malformed id', async () => {
      const w = await world();
      expect(
        (
          await t.request('GET', orgPath('0198c1a0-0000-7000-8000-000000000000'), {
            actor: w.asAdmin,
          })
        ).status,
      ).toBe(404);
      expect((await t.request('GET', orgPath('nope'), { actor: w.asAdmin })).status).toBe(422);
    });
  });

  describe('an organization created by the bot', () => {
    it('shows who added the bot to staff, and only a staff PATCH activates it', async () => {
      const w = await world();
      const pending = await t.prisma.organization.create({
        data: {
          name: 'Pending group',
          telegramChatId: BigInt(-1_000_000_099_999),
          status: 'INACTIVE',
          addedByTelegramUserId: 7_100_000_001n,
          addedByName: 'Alice K',
        },
      });
      const read = await t.request('GET', orgPath(pending.id), { actor: w.asManager });
      expect(detail(read.body)).toMatchObject({
        status: 'INACTIVE',
        addedBy: { telegramUserId: '7100000001', name: 'Alice K' },
      });
      const list = staffOrganizationListResponseSchema.parse(
        (await t.request('GET', '/staff/organizations', { actor: w.asAdmin })).body,
      );
      expect(list.items.find((o) => o.id === pending.id)?.addedBy).toEqual({
        telegramUserId: '7100000001',
        name: 'Alice K',
      });
      // An organization staff created has nobody recorded.
      expect(list.items.find((o) => o.id === w.org.id)?.addedBy).toBeNull();

      const activated = await t.request('PATCH', orgPath(pending.id), {
        actor: w.asManager,
        body: { status: 'ACTIVE' },
      });
      expect(detail(activated.body).status).toBe('ACTIVE');
      const [row] = await auditRows();
      expect(row).toMatchObject({ action: 'ORGANIZATION_UPDATED', actorUserId: w.manager.id });
    });
  });

  describe('updating an organization', () => {
    it('changes the editable fields and audits before and after', async () => {
      const w = await world();
      const res = await t.request('PATCH', orgPath(w.org.id), {
        actor: w.asManager,
        body: { name: 'Alpha Trade', status: 'INACTIVE', pricePostingEnabled: true },
      });
      expect(detail(res.body)).toMatchObject({
        name: 'Alpha Trade',
        status: 'INACTIVE',
        pricePostingEnabled: true,
      });
      const [row, ...rest] = await auditRows();
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        actorUserId: w.manager.id,
        entityType: 'ORGANIZATION',
        entityId: w.org.id,
        action: 'ORGANIZATION_UPDATED',
        diff: {
          name: { from: 'Alpha shop', to: 'Alpha Trade' },
          status: { from: 'ACTIVE', to: 'INACTIVE' },
          pricePostingEnabled: { from: false, to: true },
        },
      });
    });

    it('a no-op update writes no audit row and leaves updated_at alone', async () => {
      const w = await world();
      const before = await t.prisma.organization.findUniqueOrThrow({ where: { id: w.org.id } });
      t.clock.set(new Date('2026-10-21T08:00:00Z'));
      await t.request('PATCH', orgPath(w.org.id), {
        actor: w.asAdmin,
        body: { name: 'Alpha shop' },
      });
      const after = await t.prisma.organization.findUniqueOrThrow({ where: { id: w.org.id } });
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(await auditRows()).toEqual([]);
    });

    it.each([
      [{ telegramChatId: '-1' }],
      [{ name: '  ' }],
      [{ status: 'DELETED' }],
      [{ pricePostingEnabled: 'yes' }],
      [{}],
    ])('422 for the invalid body %j', async (body) => {
      const w = await world();
      expect((await t.request('PATCH', orgPath(w.org.id), { actor: w.asAdmin, body })).status).toBe(
        422,
      );
    });

    it('rolls the change back when the audit row cannot be written', async () => {
      const w = await world();
      vi.spyOn(t.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit down'));
      const res = await t.request('PATCH', orgPath(w.org.id), {
        actor: w.asAdmin,
        body: { name: 'Nope' },
      });
      expect(res.status).toBe(500);
      expect(
        (await t.prisma.organization.findUniqueOrThrow({ where: { id: w.org.id } })).name,
      ).toBe('Alpha shop');
    });
  });

  describe('shop owner', () => {
    it('promotes a seller once the owner is removed, and the owner stays as a seller', async () => {
      const w = await world();
      const blocked = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asManager,
        body: { userId: w.seller.id },
      });
      expect(blocked.status).toBe(409);
      expect(reason(blocked.body)).toBe('SHOP_OWNER_EXISTS');

      const removed = await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asManager,
      });
      const afterRemove = detail(removed.body);
      expect(afterRemove.shopOwner).toBeNull();
      expect(afterRemove.members.find((m) => m.userId === w.owner.id)).toMatchObject({
        role: 'SELLER',
        status: 'ACTIVE',
      });

      const promoted = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asManager,
        body: { userId: w.seller.id },
      });
      expect(promoted.status).toBe(200);
      expect(detail(promoted.body).shopOwner).toEqual({ userId: w.seller.id, fullName: 'Seller' });

      const rows = await auditRows();
      expect(rows.map((r) => r.action)).toEqual([
        'ORGANIZATION_SHOP_OWNER_REMOVED',
        'ORGANIZATION_SHOP_OWNER_ASSIGNED',
      ]);
      expect(rows[0]?.diff).toEqual({
        [`members.${w.owner.id}.role`]: { from: 'SHOP_OWNER', to: 'SELLER' },
      });
    });

    it('adds a person who belongs to no organization yet, and brings back a former member', async () => {
      const w = await world();
      await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), { actor: w.asAdmin });
      const newcomer = await makeUser(t.prisma, { name: 'Newcomer' });
      const res = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: newcomer.id },
      });
      expect(detail(res.body).members.find((m) => m.userId === newcomer.id)).toMatchObject({
        role: 'SHOP_OWNER',
        status: 'ACTIVE',
      });

      await t.request('POST', orgPath(w.org.id, `/members/${newcomer.id}/leave`), {
        actor: w.asAdmin,
      });
      const back = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: newcomer.id },
      });
      const member = detail(back.body).members.find((m) => m.userId === newcomer.id);
      expect(member).toMatchObject({ role: 'SHOP_OWNER', status: 'ACTIVE', leftAt: null });
    });

    it('is idempotent for the current owner', async () => {
      const w = await world();
      const res = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: w.owner.id },
      });
      expect(res.status).toBe(200);
      expect(await auditRows()).toEqual([]);
    });

    it('refuses staff (MEMBER_IS_STAFF) and people in another organization (ALREADY_MEMBER_ELSEWHERE)', async () => {
      const w = await world();
      await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), { actor: w.asAdmin });
      const auditCount = (await auditRows()).length;

      const staff = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: w.manager.id },
      });
      expect(staff.status).toBe(409);
      expect(reason(staff.body)).toBe('MEMBER_IS_STAFF');

      const otherOrg = await makeOrganization(t.prisma, { name: 'Beta shop' });
      const member = await makeUser(t.prisma, { name: 'Busy' });
      await makeMember(t.prisma, otherOrg.id, member.id);
      const elsewhere = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: member.id },
      });
      expect(elsewhere.status).toBe(409);
      expect(reason(elsewhere.body)).toBe('ALREADY_MEMBER_ELSEWHERE');

      expect(await t.prisma.userRole.count({ where: { userId: member.id } })).toBe(0);
      expect(await auditRows()).toHaveLength(auditCount);
    });

    it('refuses a BLOCKED user (USER_BLOCKED) and an INACTIVE organization (ORGANIZATION_INACTIVE)', async () => {
      const w = await world();
      await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), { actor: w.asAdmin });
      const auditCount = (await auditRows()).length;

      const blockedUser = await makeUser(t.prisma, { name: 'Blocked', status: 'BLOCKED' });
      const blocked = await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: blockedUser.id },
      });
      expect(blocked.status).toBe(409);
      expect(reason(blocked.body)).toBe('USER_BLOCKED');

      const inactiveOrg = await makeOrganization(t.prisma, { name: 'Closed', status: 'INACTIVE' });
      const candidate = await makeUser(t.prisma, { name: 'Candidate' });
      const inactive = await t.request('PUT', orgPath(inactiveOrg.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: candidate.id },
      });
      expect(inactive.status).toBe(409);
      expect(reason(inactive.body)).toBe('ORGANIZATION_INACTIVE');

      expect(await t.prisma.organizationMember.count({ where: { userId: candidate.id } })).toBe(0);
      expect(await t.prisma.organizationMember.count({ where: { userId: blockedUser.id } })).toBe(
        0,
      );
      expect(await auditRows()).toHaveLength(auditCount);
    });

    it('404 for an unknown user or organization, 422 for a bad body, 404 when there is no owner to remove', async () => {
      const w = await world();
      const ghost = '0198c1a0-0000-7000-8000-000000000000';
      expect(
        (
          await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
            actor: w.asAdmin,
            body: { userId: ghost },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await t.request('PUT', orgPath(ghost, '/shop-owner'), {
            actor: w.asAdmin,
            body: { userId: w.seller.id },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
            actor: w.asAdmin,
            body: { userId: 'x' },
          })
        ).status,
      ).toBe(422);
      await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), { actor: w.asAdmin });
      expect(
        (await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), { actor: w.asAdmin })).status,
      ).toBe(404);
    });

    it('two simultaneous assignments leave exactly one owner', async () => {
      const w = await world();
      await t.request('DELETE', orgPath(w.org.id, '/shop-owner'), { actor: w.asAdmin });
      const a = await makeUser(t.prisma, { name: 'A' });
      const b = await makeUser(t.prisma, { name: 'B' });
      const results = await Promise.all(
        [a, b].map((u) =>
          t.request('PUT', orgPath(w.org.id, '/shop-owner'), {
            actor: w.asAdmin,
            body: { userId: u.id },
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await t.prisma.organizationMember.count({
          where: { organizationId: w.org.id, role: 'SHOP_OWNER', status: 'ACTIVE' },
        }),
      ).toBe(1);
    });
  });

  describe('members', () => {
    it('changes a member role, never creating a second owner', async () => {
      const w = await world();
      const conflict = await t.request('PATCH', orgPath(w.org.id, `/members/${w.seller.id}`), {
        actor: w.asManager,
        body: { role: 'SHOP_OWNER' },
      });
      expect(conflict.status).toBe(409);
      expect(reason(conflict.body)).toBe('SHOP_OWNER_EXISTS');

      const demote = await t.request('PATCH', orgPath(w.org.id, `/members/${w.owner.id}`), {
        actor: w.asManager,
        body: { role: 'SELLER' },
      });
      expect(detail(demote.body).shopOwner).toBeNull();
      const promote = await t.request('PATCH', orgPath(w.org.id, `/members/${w.seller.id}`), {
        actor: w.asManager,
        body: { role: 'SHOP_OWNER' },
      });
      expect(detail(promote.body).shopOwner?.userId).toBe(w.seller.id);
      expect((await auditRows()).map((r) => r.action)).toEqual([
        'ORGANIZATION_MEMBER_ROLE_CHANGED',
        'ORGANIZATION_MEMBER_ROLE_CHANGED',
      ]);
    });

    it('same role is a no-op; non-members and former members give 404; bad role 422', async () => {
      const w = await world();
      const same = await t.request('PATCH', orgPath(w.org.id, `/members/${w.seller.id}`), {
        actor: w.asAdmin,
        body: { role: 'SELLER' },
      });
      expect(same.status).toBe(200);
      expect(await auditRows()).toEqual([]);

      const stranger = await makeUser(t.prisma);
      expect(
        (
          await t.request('PATCH', orgPath(w.org.id, `/members/${stranger.id}`), {
            actor: w.asAdmin,
            body: { role: 'SELLER' },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await t.request('PATCH', orgPath(w.org.id, `/members/${w.seller.id}`), {
            actor: w.asAdmin,
            body: { role: 'BOSS' },
          })
        ).status,
      ).toBe(422);
    });

    it('a member of another organization cannot be changed through this one', async () => {
      const w = await world();
      const otherOrg = await makeOrganization(t.prisma, { name: 'Beta shop' });
      const outsider = await makeUser(t.prisma, { name: 'Outsider' });
      await makeMember(t.prisma, otherOrg.id, outsider.id);
      for (const [method, tail, body] of [
        ['PATCH', `/members/${outsider.id}`, { role: 'SHOP_OWNER' }],
        ['POST', `/members/${outsider.id}/leave`, undefined],
      ] as const) {
        expect(
          (await t.request(method, orgPath(w.org.id, tail), { actor: w.asAdmin, body })).status,
        ).toBe(404);
      }
      const row = await t.prisma.organizationMember.findFirstOrThrow({
        where: { userId: outsider.id },
      });
      expect(row.status).toBe('ACTIVE');
    });

    it('marks a member as left with the Clock time, idempotently, and frees them for another organization', async () => {
      const w = await world();
      t.clock.set(new Date('2026-10-22T09:30:00Z'));
      const res = await t.request('POST', orgPath(w.org.id, `/members/${w.seller.id}/leave`), {
        actor: w.asManager,
      });
      const left = detail(res.body).members.find((m) => m.userId === w.seller.id);
      expect(left).toMatchObject({ status: 'LEFT', leftAt: '2026-10-22T09:30:00.000Z' });
      expect(detail(res.body).activeMemberCount).toBe(1);

      t.clock.set(new Date('2026-10-23T09:30:00Z'));
      const again = await t.request('POST', orgPath(w.org.id, `/members/${w.seller.id}/leave`), {
        actor: w.asManager,
      });
      expect(detail(again.body).members.find((m) => m.userId === w.seller.id)?.leftAt).toBe(
        '2026-10-22T09:30:00.000Z',
      );
      expect((await auditRows()).map((r) => r.action)).toEqual(['ORGANIZATION_MEMBER_LEFT']);

      const otherOrg = await makeOrganization(t.prisma, { name: 'Beta shop' });
      const join = await t.request('PUT', orgPath(otherOrg.id, '/shop-owner'), {
        actor: w.asAdmin,
        body: { userId: w.seller.id },
      });
      expect(join.status).toBe(200);
    });

    it('404 for a person who was never a member', async () => {
      const w = await world();
      const stranger = await makeUser(t.prisma);
      expect(
        (
          await t.request('POST', orgPath(w.org.id, `/members/${stranger.id}/leave`), {
            actor: w.asAdmin,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('isolation', () => {
    it('no customer, of any organization, can read any organization endpoint', async () => {
      const w = await world();
      const otherOrg = await makeOrganization(t.prisma, { name: 'Beta shop' });
      const otherOwner = await makeUser(t.prisma, { name: 'Beta owner', phone: '+998907776655' });
      await makeMember(t.prisma, otherOrg.id, otherOwner.id, 'SHOP_OWNER');
      const outsider = customerActor(otherOwner.id, otherOrg.id, 'SHOP_OWNER');

      for (const path of ['/staff/organizations', orgPath(w.org.id), orgPath(otherOrg.id)]) {
        const res = await t.request('GET', path, { actor: outsider });
        expect(res.status, path).toBe(403);
        const text = JSON.stringify(res.body);
        for (const secret of ['Alpha', 'Owner', '998901112233', '998904445566', '998907776655']) {
          expect(text).not.toContain(secret);
        }
      }
    });
  });
});
