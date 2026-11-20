import { Injectable } from '@nestjs/common';
import type { Locale, StaffRole, UserStatusName } from '@iorder/shared';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { escapeLike } from '../../common/database/like.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { phoneSearchDigits } from './phone-search.js';
import type { KickTarget } from '../../common/outbox/kick-member.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ActiveMembershipView, UserView } from './user.view.js';

const WITH_ROLES = { roles: { select: { role: true }, orderBy: { role: 'asc' } } } as const;

type UserRow = Prisma.UserGetPayload<{ include: typeof WITH_ROLES }>;

function toView(row: UserRow): UserView {
  return {
    id: row.id,
    telegramUserId: row.telegramUserId,
    fullName: row.fullName,
    phone: row.phone,
    language: row.language,
    status: row.status,
    staffRoles: row.roles.map((r) => r.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface UserFilter {
  search?: string;
  /** The search also matches a Telegram id; off for a role that may not know them. */
  searchTelegramId?: boolean;
  status?: UserStatusName;
  role?: StaffRole;
}

@Injectable()
export class IdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The plain client, for reads that do not need a transaction. */
  get client(): DbClient {
    return this.prisma;
  }

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  async findById(id: string, db?: DbClient): Promise<UserView | null> {
    const row = await (db ?? this.prisma).user.findUnique({ where: { id }, include: WITH_ROLES });
    return row ? toView(row) : null;
  }

  async findByIds(ids: readonly string[], db?: DbClient): Promise<UserView[]> {
    if (ids.length === 0) return [];
    const rows = await (db ?? this.prisma).user.findMany({
      where: { id: { in: [...ids] } },
      include: WITH_ROLES,
    });
    return rows.map(toView);
  }

  async findByTelegramId(telegramUserId: bigint, db?: DbClient): Promise<UserView | null> {
    const row = await (db ?? this.prisma).user.findUnique({
      where: { telegramUserId },
      include: WITH_ROLES,
    });
    return row ? toView(row) : null;
  }

  async list(filter: UserFilter): Promise<UserView[]> {
    const search = filter.search;
    const where: Prisma.UserWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.role ? { roles: { some: { role: filter.role } } } : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: escapeLike(search), mode: 'insensitive' } },
              { phone: { contains: escapeLike(search) } },
              // Digits only and short enough for BigInt to mean a Telegram id.
              ...(filter.searchTelegramId === true && /^[1-9]\d{0,15}$/.test(search)
                ? [{ telegramUserId: BigInt(search) }]
                : []),
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      include: WITH_ROLES,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toView);
  }

  async findIdsByName(search: string, take: number): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { fullName: { contains: escapeLike(search), mode: 'insensitive' } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    return rows.map((row) => row.id);
  }

  /**
   * Ids of people whose name contains the text (any letter case) or whose phone contains its digits
   * (spaces, dashes and a leading + ignored; at least three digits, so "90" alone matches nobody).
   */
  async findIdsByNameOrPhone(search: string, take: number): Promise<string[]> {
    const digits = phoneSearchDigits(search);
    const byPhone = digits === null ? [] : [{ phone: { contains: digits } }];
    const rows = await this.prisma.user.findMany({
      where: {
        OR: [{ fullName: { contains: escapeLike(search), mode: 'insensitive' } }, ...byPhone],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    return rows.map((row) => row.id);
  }

  /** Everybody who holds at least one staff role (customers never appear). */
  async listStaff(): Promise<UserView[]> {
    const rows = await this.prisma.user.findMany({
      where: { roles: { some: {} } },
      include: WITH_ROLES,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toView);
  }

  /** Row lock so the "before" values written to the audit log are the ones really replaced. */
  async lockById(tx: Tx, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    return rows.length > 0;
  }

  /**
   * Serializes every change that could remove an administrator: held until the transaction ends,
   * so the "how many active admins are left" count that follows cannot be raced.
   */
  async lockAdminSet(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('iorder.identity.admin-set'))`;
  }

  async countActiveAdmins(tx: Tx): Promise<number> {
    return tx.user.count({ where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } } });
  }

  async create(
    tx: Tx,
    data: {
      telegramUserId: bigint | null;
      fullName: string;
      phone?: string;
      language?: Locale;
      now: Date;
    },
  ): Promise<UserView> {
    const row = await tx.user.create({
      data: {
        telegramUserId: data.telegramUserId,
        fullName: data.fullName,
        ...(data.phone === undefined ? {} : { phone: data.phone }),
        ...(data.language === undefined ? {} : { language: data.language }),
        createdAt: data.now,
        updatedAt: data.now,
      },
      include: WITH_ROLES,
    });
    return toView(row);
  }

  async updateFields(
    tx: Tx,
    id: string,
    data: Prisma.UserUpdateInput & { updatedAt: Date },
  ): Promise<void> {
    await tx.user.update({ where: { id }, data });
  }

  /** Returns true when the role was newly added, false when the user already held it. */
  async addRole(tx: Tx, userId: string, role: StaffRole): Promise<boolean> {
    const result = await tx.userRole.createMany({
      data: [{ userId, role }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  /** Returns true when a role was removed. */
  async removeRole(tx: Tx, userId: string, role: StaffRole): Promise<boolean> {
    const result = await tx.userRole.deleteMany({ where: { userId, role } });
    return result.count === 1;
  }

  /**
   * READ-ONLY look at `organization_members` / `organizations`. The one deliberate exception to
   * "never touch another module's tables": an Actor is by definition staff roles OR an active
   * membership, so identity must see both to build one. Writes to these tables belong to the
   * organizations module only.
   */
  async findActiveMemberships(
    userIds: readonly string[],
    db?: DbClient,
  ): Promise<ActiveMembershipView[]> {
    if (userIds.length === 0) return [];
    const rows = await (db ?? this.prisma).organizationMember.findMany({
      where: { userId: { in: [...userIds] }, status: 'ACTIVE' },
      include: { organization: { select: { id: true, name: true, status: true } } },
    });
    return rows.map((row) => ({
      userId: row.userId,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      organizationActive: row.organization.status === 'ACTIVE',
      role: row.role,
      joinedAt: row.joinedAt,
    }));
  }

  /**
   * READ-ONLY, same exception as above: the name of an organization while it is ACTIVE, null for
   * an unknown or inactive one. For the staff viewer's "orders are written to ..." line of `/me`.
   */
  async findActiveOrganizationName(id: string): Promise<string | null> {
    const row = await this.prisma.organization.findUnique({
      where: { id },
      select: { name: true, status: true },
    });
    return row?.status === 'ACTIVE' ? row.name : null;
  }

  /**
   * READ-ONLY, same exception as above: the ACTIVE memberships of one person with the Telegram
   * chat id of each group, for the group-removal request written by a block.
   */
  async findKickTargets(tx: Tx, userId: string): Promise<KickTarget[]> {
    // Only groups: a PERSON organization's chat is the person's own private chat, nothing to
    // remove them from (their membership is ended by staff, and a blocked person is refused anyway).
    const rows = await tx.organizationMember.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        organization: { type: 'GROUP', telegramChatId: { not: null } },
      },
      include: { organization: { select: { telegramChatId: true } } },
      orderBy: { organizationId: 'asc' },
    });
    return rows.flatMap((row) =>
      row.organization.telegramChatId === null
        ? []
        : [
            {
              organizationId: row.organizationId,
              organizationChatId: row.organization.telegramChatId.toString(),
              joinedAt: row.joinedAt,
            },
          ],
    );
  }
}
