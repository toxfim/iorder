import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/common/database/prisma.service.js';
import { mapMembershipGuardError } from '../src/common/database/staff-membership-guard.js';
import { ConflictError } from '../src/common/errors/domain-errors.js';
import { createTestPrisma, resetIdentity } from './support/test-db.js';

// Database-level guarantees of the identity tables. They must hold even if a service has a bug
// or two requests race, so everything here goes around the services.
describe('identity tables (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let counter = 0;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetIdentity(prisma);
  });

  const user = (name = 'Person') =>
    prisma.user.create({ data: { telegramUserId: BigInt(++counter + 1000), fullName: name } });
  const organization = (name = 'Shop') =>
    prisma.organization.create({ data: { name, telegramChatId: BigInt(-(++counter + 5000)) } });
  const member = (
    organizationId: string,
    userId: string,
    role: 'SHOP_OWNER' | 'SELLER' = 'SELLER',
    status: 'ACTIVE' | 'LEFT' = 'ACTIVE',
  ) =>
    prisma.organizationMember.create({
      data: {
        organizationId,
        userId,
        role,
        status,
        joinedAt: new Date(),
        leftAt: status === 'LEFT' ? new Date() : null,
      },
    });

  describe('uniqueness', () => {
    it('keeps Telegram ids unique and positive, names non-blank', async () => {
      const first = await user();
      await expect(
        prisma.user.create({ data: { telegramUserId: first.telegramUserId, fullName: 'Dup' } }),
      ).rejects.toThrow();
      await expect(
        prisma.user.create({ data: { telegramUserId: 0n, fullName: 'Zero' } }),
      ).rejects.toThrow(/users_telegram_user_id_positive/);
      await expect(
        prisma.user.create({ data: { telegramUserId: -5n, fullName: 'Neg' } }),
      ).rejects.toThrow(/users_telegram_user_id_positive/);
      await expect(
        prisma.user.create({ data: { telegramUserId: 99n, fullName: '   ' } }),
      ).rejects.toThrow(/users_full_name_not_blank/);
    });

    it('stores Telegram ids above 2^31 without loss', async () => {
      const big = 4503599627370495n;
      const created = await prisma.user.create({ data: { telegramUserId: big, fullName: 'Big' } });
      const [row] = await prisma.$queryRaw<{ telegram_user_id: bigint }[]>`
        SELECT telegram_user_id FROM users WHERE id = ${created.id}::uuid`;
      expect(row?.telegram_user_id).toBe(big);
    });

    it('lets a user have at most ONE active membership, but any number of former ones', async () => {
      const [a, b, c] = await Promise.all([
        organization('A'),
        organization('B'),
        organization('C'),
      ]);
      const person = await user();
      await member(a.id, person.id);
      await expect(member(b.id, person.id)).rejects.toThrow(
        /organization_members_one_active_per_user/,
      );
      await prisma.organizationMember.update({
        where: { organizationId_userId: { organizationId: a.id, userId: person.id } },
        data: { status: 'LEFT', leftAt: new Date() },
      });
      await member(b.id, person.id);
      await member(c.id, person.id, 'SELLER', 'LEFT');
      await expect(
        prisma.organizationMember.update({
          where: { organizationId_userId: { organizationId: c.id, userId: person.id } },
          data: { status: 'ACTIVE', leftAt: null },
        }),
      ).rejects.toThrow(/organization_members_one_active_per_user/);
    });

    it('lets an organization have at most ONE active shop owner', async () => {
      const org = await organization();
      const [first, second, third] = await Promise.all([user(), user(), user()]);
      await member(org.id, first!.id, 'SHOP_OWNER');
      await expect(member(org.id, second!.id, 'SHOP_OWNER')).rejects.toThrow(
        /organization_members_one_active_owner_per_organization/,
      );
      await member(org.id, second!.id, 'SELLER');
      await member(org.id, third!.id, 'SELLER');
      await expect(
        prisma.organizationMember.update({
          where: { organizationId_userId: { organizationId: org.id, userId: second!.id } },
          data: { role: 'SHOP_OWNER' },
        }),
      ).rejects.toThrow(/organization_members_one_active_owner_per_organization/);
      // A former owner does not block a new one.
      await prisma.organizationMember.update({
        where: { organizationId_userId: { organizationId: org.id, userId: first!.id } },
        data: { status: 'LEFT', leftAt: new Date() },
      });
      await prisma.organizationMember.update({
        where: { organizationId_userId: { organizationId: org.id, userId: second!.id } },
        data: { role: 'SHOP_OWNER' },
      });
    });

    it('keeps left_at consistent with the status', async () => {
      const org = await organization();
      const person = await user();
      await expect(
        prisma.organizationMember.create({
          data: {
            organizationId: org.id,
            userId: person.id,
            role: 'SELLER',
            status: 'ACTIVE',
            joinedAt: new Date(),
            leftAt: new Date(),
          },
        }),
      ).rejects.toThrow(/organization_members_left_at_matches_status/);
      await expect(
        prisma.organizationMember.create({
          data: {
            organizationId: org.id,
            userId: person.id,
            role: 'SELLER',
            status: 'LEFT',
            joinedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/organization_members_left_at_matches_status/);
    });

    it('does not allow deleting a user or organization that has dependants', async () => {
      const org = await organization();
      const person = await user();
      await member(org.id, person.id);
      await expect(prisma.user.delete({ where: { id: person.id } })).rejects.toThrow();
      await expect(prisma.organization.delete({ where: { id: org.id } })).rejects.toThrow();
    });
  });

  describe('staff are never organization members (invariant 9)', () => {
    it('refuses a staff role for a user with an ACTIVE membership', async () => {
      const org = await organization();
      const person = await user();
      await member(org.id, person.id);
      await expect(
        prisma.userRole.create({ data: { userId: person.id, role: 'MANAGER' } }),
      ).rejects.toThrow(/staff_role_conflicts_with_membership/);
      expect(await prisma.userRole.count({ where: { userId: person.id } })).toBe(0);
    });

    it('allows a staff role for a user whose membership has ended', async () => {
      const org = await organization();
      const person = await user();
      await member(org.id, person.id, 'SELLER', 'LEFT');
      await prisma.userRole.create({ data: { userId: person.id, role: 'DRIVER' } });
    });

    it('refuses an ACTIVE membership for a staff user, on insert and on reactivation', async () => {
      const org = await organization();
      const staff = await user();
      await prisma.userRole.create({ data: { userId: staff.id, role: 'ACCOUNTANT' } });
      await expect(member(org.id, staff.id)).rejects.toThrow(
        /membership_conflicts_with_staff_role/,
      );

      const formerMember = await user();
      await member(org.id, formerMember.id, 'SELLER', 'LEFT');
      await prisma.userRole.create({
        data: { userId: formerMember.id, role: 'WAREHOUSE_MANAGER' },
      });
      await expect(
        prisma.organizationMember.update({
          where: { organizationId_userId: { organizationId: org.id, userId: formerMember.id } },
          data: { status: 'ACTIVE', leftAt: null },
        }),
      ).rejects.toThrow(/membership_conflicts_with_staff_role/);
    });

    it('holds under concurrency: a role and a membership for the same person never both commit', async () => {
      const org = await organization();
      for (let round = 0; round < 20; round += 1) {
        const person = await user(`Racer ${round}`);
        const results = await Promise.allSettled([
          prisma.userRole.create({ data: { userId: person.id, role: 'MANAGER' } }),
          member(org.id, person.id),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled, `round ${round}`).toBe(1);
        const roles = await prisma.userRole.count({ where: { userId: person.id } });
        const active = await prisma.organizationMember.count({
          where: { userId: person.id, status: 'ACTIVE' },
        });
        expect(roles + active, `round ${round}`).toBe(1);
      }
    });
  });

  describe('mapMembershipGuardError on real database errors', () => {
    const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
      try {
        await work;
      } catch (error) {
        return mapMembershipGuardError(error);
      }
      throw new Error('expected the statement to fail');
    };

    it('a second ACTIVE membership of the same user -> ALREADY_MEMBER_ELSEWHERE', async () => {
      const [a, b] = await Promise.all([organization('A'), organization('B')]);
      const person = await user();
      await member(a.id, person.id);
      const mapped = await failureOf(member(b.id, person.id));
      expect(mapped).toBeInstanceOf(ConflictError);
      expect((mapped as ConflictError).reason).toBe('ALREADY_MEMBER_ELSEWHERE');
    });

    it('a second ACTIVE shop owner of an organization -> SHOP_OWNER_EXISTS', async () => {
      const org = await organization();
      const [first, second] = await Promise.all([user(), user()]);
      await member(org.id, first!.id, 'SHOP_OWNER');
      const mapped = await failureOf(member(org.id, second!.id, 'SHOP_OWNER'));
      expect(mapped).toBeInstanceOf(ConflictError);
      expect((mapped as ConflictError).reason).toBe('SHOP_OWNER_EXISTS');
    });

    it('both staff triggers -> STAFF_HAS_MEMBERSHIP / MEMBER_IS_STAFF', async () => {
      const org = await organization();
      const [member1, staff] = await Promise.all([user(), user()]);
      await member(org.id, member1!.id);
      await prisma.userRole.create({ data: { userId: staff!.id, role: 'MANAGER' } });
      const role = await failureOf(
        prisma.userRole.create({ data: { userId: member1!.id, role: 'DRIVER' } }),
      );
      expect((role as ConflictError).reason).toBe('STAFF_HAS_MEMBERSHIP');
      const asMember = await failureOf(member(org.id, staff!.id));
      expect((asMember as ConflictError).reason).toBe('MEMBER_IS_STAFF');
    });
  });

  describe('TRUNCATE guards', () => {
    it('refuses TRUNCATE (also CASCADE) on every identity table, even for the owner', async () => {
      const org = await organization();
      const person = await user();
      await member(org.id, person.id);
      for (const table of ['users', 'user_roles', 'organizations', 'organization_members']) {
        await expect(prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`), table).rejects.toThrow(
          /TRUNCATE of .* is not allowed/,
        );
      }
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.organizationMember.count()).toBe(1);
    });
  });

  describe('audit system sources', () => {
    const insert = (action: string) =>
      prisma.$executeRaw`INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, diff, created_at)
        VALUES (${randomUUID()}::uuid, NULL, 'T', 'e', ${action}, '{}'::jsonb, now())`;

    it('allows a NULL actor for BOOTSTRAP_* (and the older sources), nothing else', async () => {
      await expect(insert('BOOTSTRAP_ADMIN_ENSURED')).resolves.toBe(1);
      await expect(insert('SHEET_SYNC_CREATED')).resolves.toBe(1);
      await expect(insert('BOOTSTRAP')).rejects.toThrow(/audit_log_actor_required/);
      await expect(insert('XBOOTSTRAP_A')).rejects.toThrow(/audit_log_actor_required/);
      await expect(insert('USER_BLOCKED')).rejects.toThrow(/audit_log_actor_required/);
    });

    it('allows a NULL actor for TELEGRAM_* (the bot), with the exact prefix only', async () => {
      await expect(insert('TELEGRAM_ORGANIZATION_CREATED')).resolves.toBe(1);
      await expect(insert('RATE_REFRESH_UPDATED')).resolves.toBe(1);
      await expect(insert('TELEGRAM')).rejects.toThrow(/audit_log_actor_required/);
      await expect(insert('XTELEGRAM_A')).rejects.toThrow(/audit_log_actor_required/);
      await expect(insert('TELEGRAMS_A')).rejects.toThrow(/audit_log_actor_required/);
    });
  });
});
