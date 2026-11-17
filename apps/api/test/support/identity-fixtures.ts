import type { OrganizationRole, StaffRole } from '@iorder/shared';
import type { Actor } from '../../src/common/auth/actor.js';
import type { PrismaService } from '../../src/common/database/prisma.service.js';

let counter = 0;

/** Direct database fixtures: they go around the services on purpose. */
export async function makeUser(
  prisma: PrismaService,
  options: {
    name?: string;
    phone?: string | null;
    staff?: StaffRole[];
    status?: 'ACTIVE' | 'BLOCKED';
    telegramUserId?: bigint;
  } = {},
): Promise<{ id: string; telegramUserId: bigint; fullName: string }> {
  counter += 1;
  const telegramUserId = options.telegramUserId ?? BigInt(7_000_000_000 + counter);
  const user = await prisma.user.create({
    data: {
      telegramUserId,
      fullName: options.name ?? `Person ${counter}`,
      phone: options.phone ?? null,
      status: options.status ?? 'ACTIVE',
      roles: { create: (options.staff ?? []).map((role) => ({ role })) },
    },
  });
  return { id: user.id, telegramUserId, fullName: user.fullName };
}

export async function makeOrganization(
  prisma: PrismaService,
  options: { name?: string; status?: 'ACTIVE' | 'INACTIVE' } = {},
): Promise<{ id: string; name: string }> {
  counter += 1;
  const org = await prisma.organization.create({
    data: {
      name: options.name ?? `Shop ${counter}`,
      telegramChatId: BigInt(-1_000_000_000_000 - counter),
      status: options.status ?? 'ACTIVE',
    },
  });
  return { id: org.id, name: org.name };
}

export async function makeMember(
  prisma: PrismaService,
  organizationId: string,
  userId: string,
  role: OrganizationRole = 'SELLER',
  status: 'ACTIVE' | 'LEFT' = 'ACTIVE',
): Promise<void> {
  await prisma.organizationMember.create({
    data: {
      organizationId,
      userId,
      role,
      status,
      joinedAt: new Date('2026-10-01T00:00:00Z'),
      leftAt: status === 'LEFT' ? new Date('2026-10-10T00:00:00Z') : null,
    },
  });
}

export const staffActor = (userId: string, ...roles: StaffRole[]): Actor => ({
  userId,
  staffRoles: roles,
});

export const customerActor = (
  userId: string,
  organizationId: string,
  role: OrganizationRole = 'SELLER',
): Actor => ({ userId, staffRoles: [], membership: { organizationId, role } });
