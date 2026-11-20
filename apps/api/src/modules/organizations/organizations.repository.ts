import { Injectable } from '@nestjs/common';
import type { OrganizationLabel, OrganizationRole, OrganizationType } from '@iorder/shared';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { escapeLike } from '../../common/database/like.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { MemberView, OrganizationView, OrganizationWithMembers } from './organization.view.js';

const WITH_MEMBERS = {
  members: { orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] },
  // At most one by the partial unique index organization_invites_one_open.
  invites: { where: { usedAt: null, revokedAt: null }, select: { expiresAt: true }, take: 1 },
} satisfies Prisma.OrganizationInclude;

type OrganizationRow = Prisma.OrganizationGetPayload<{ include: typeof WITH_MEMBERS }>;

/** Organizations a bot-registered group was merged into are history: never listed or counted. */
const NOT_MERGED = { mergedIntoOrganizationId: null } satisfies Prisma.OrganizationWhereInput;

function toMember(row: OrganizationRow['members'][number]): MemberView {
  return {
    userId: row.userId,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
  };
}

function toView(row: OrganizationRow): OrganizationWithMembers {
  const invite = row.invites[0];
  const organization: OrganizationView = {
    id: row.id,
    name: row.name,
    type: row.type,
    label: row.label,
    phone: row.phone,
    telegramChatId: row.telegramChatId,
    status: row.status,
    pricePostingEnabled: row.pricePostingEnabled,
    addedBy:
      row.addedByTelegramUserId === null
        ? null
        : { telegramUserId: row.addedByTelegramUserId, name: row.addedByName ?? '' },
    createdByUserId: row.createdByUserId,
    merged: row.mergedIntoOrganizationId !== null,
    openInvite: invite ? { expiresAt: invite.expiresAt } : null,
    archivedAt: row.archivedAt,
    archivedByUserId: row.archivedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return { organization, members: row.members.map(toMember) };
}

/** What other modules may know about an organization to show it next to an order. */
export interface OrganizationContactInfo {
  id: string;
  name: string;
  type: OrganizationType;
  label: OrganizationLabel;
  shopOwnerUserId: string | null;
}

export interface OrganizationFilter {
  search?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  type?: OrganizationType;
  label?: OrganizationLabel;
  /** [C, owner 2026-11-13] false = archived ones left out (the default), true = only archived ones. */
  archived: boolean;
}

/** What the price post decides on for one organization. */
export interface PricePostingCandidate {
  id: string;
  type: OrganizationType;
  label: OrganizationLabel;
  status: 'ACTIVE' | 'INACTIVE';
  pricePostingEnabled: boolean;
  /** A chat is bound (always true for a group the bot registered). */
  bound: boolean;
}

/** One organization invite as the bot's start handler sees it under its row lock. */
export interface InviteRecord {
  id: string;
  organizationId: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  async findById(id: string, db?: DbClient): Promise<OrganizationWithMembers | null> {
    const row = await (db ?? this.prisma).organization.findUnique({
      where: { id },
      include: WITH_MEMBERS,
    });
    return row ? toView(row) : null;
  }

  /**
   * Every organization (merged and archived ones left out: an archived one is INACTIVE anyway, and
   * it is no longer counted among the skipped) with what the price post decides on; one query.
   */
  async findPricePostingCandidates(db?: DbClient): Promise<PricePostingCandidate[]> {
    const rows = await (db ?? this.prisma).organization.findMany({
      where: { ...NOT_MERGED, archivedAt: null },
      select: {
        id: true,
        type: true,
        label: true,
        status: true,
        pricePostingEnabled: true,
        telegramChatId: true,
      },
      orderBy: { id: 'asc' },
    });
    return rows.map(({ telegramChatId, ...row }) => ({ ...row, bound: telegramChatId !== null }));
  }

  /**
   * Organizations that wait for a manager to activate them (INACTIVE with a chat), one query. A
   * staff-created one without a chat waits for its invite, not for a manager, and an archived one
   * waits for nobody: neither is counted.
   */
  countInactive(): Promise<number> {
    return this.prisma.organization.count({
      where: { status: 'INACTIVE', telegramChatId: { not: null }, archivedAt: null, ...NOT_MERGED },
    });
  }

  async findLabel(id: string): Promise<OrganizationLabel | null> {
    const row = await this.prisma.organization.findUnique({
      where: { id },
      select: { label: true },
    });
    return row?.label ?? null;
  }

  /** Names and the ACTIVE shop owner, for other modules. One query for any number of ids. */
  async findContactInfo(ids: readonly string[]): Promise<OrganizationContactInfo[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.organization.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        name: true,
        type: true,
        label: true,
        members: { where: { role: 'SHOP_OWNER', status: 'ACTIVE' }, select: { userId: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      label: row.label,
      shopOwnerUserId: row.members[0]?.userId ?? null,
    }));
  }

  async findByChatId(chatId: bigint, db?: DbClient): Promise<OrganizationWithMembers | null> {
    const row = await (db ?? this.prisma).organization.findUnique({
      where: { telegramChatId: chatId },
      include: WITH_MEMBERS,
    });
    return row ? toView(row) : null;
  }

  /** The Telegram time of the last status event, read under the caller's row lock. */
  async findTelegramStatusEventAt(tx: Tx, id: string): Promise<Date | null> {
    const row = await tx.organization.findUnique({
      where: { id },
      select: { telegramStatusEventAt: true },
    });
    return row?.telegramStatusEventAt ?? null;
  }

  /** Records that a Telegram event of this time was seen, without touching `updated_at`. */
  async setTelegramStatusEventAt(tx: Tx, id: string, eventAt: Date): Promise<void> {
    await tx.organization.update({ where: { id }, data: { telegramStatusEventAt: eventAt } });
  }

  async createFromTelegram(
    tx: Tx,
    data: {
      name: string;
      chatId: bigint;
      now: Date;
      eventAt: Date;
      addedBy: { telegramUserId: bigint; name: string } | null;
    },
  ): Promise<string> {
    const row = await tx.organization.create({
      data: {
        name: data.name,
        type: 'GROUP',
        // Owner decision: the bot never starts an organization ACTIVE. Written out here (not left
        // to the column default, which staff-created organizations use).
        status: 'INACTIVE',
        addedByTelegramUserId: data.addedBy?.telegramUserId ?? null,
        addedByName: data.addedBy?.name ?? null,
        telegramChatId: data.chatId,
        createdAt: data.now,
        updatedAt: data.now,
        telegramStatusEventAt: data.eventAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** A staff-created organization: INACTIVE and without a chat until its invite is used. */
  async createByStaff(
    tx: Tx,
    data: {
      type: OrganizationType;
      name: string;
      label: OrganizationLabel;
      phone: string | null;
      createdByUserId: string;
      now: Date;
    },
  ): Promise<string> {
    const row = await tx.organization.create({
      data: {
        type: data.type,
        name: data.name,
        label: data.label,
        phone: data.phone,
        status: 'INACTIVE',
        telegramChatId: null,
        createdByUserId: data.createdByUserId,
        createdAt: data.now,
        updatedAt: data.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async insertInvite(
    tx: Tx,
    data: {
      organizationId: string;
      token: string;
      createdByUserId: string;
      createdAt: Date;
      expiresAt: Date;
    },
  ): Promise<void> {
    await tx.organizationInvite.create({ data });
  }

  /** Revokes the open invite of an organization (at most one exists). Returns how many. */
  async revokeOpenInvites(tx: Tx, organizationId: string, now: Date): Promise<number> {
    const result = await tx.organizationInvite.updateMany({
      where: { organizationId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count;
  }

  /** The open invite's token, for the staff link (staff-only data). */
  findOpenInviteToken(organizationId: string): Promise<{ token: string; expiresAt: Date } | null> {
    return this.prisma.organizationInvite.findFirst({
      where: { organizationId, usedAt: null, revokedAt: null },
      select: { token: true, expiresAt: true },
    });
  }

  /** The invite of a token without a lock: the cheap first check of a Start press. */
  findInviteByToken(token: string): Promise<{
    organizationId: string;
    expiresAt: Date;
    usedAt: Date | null;
    revokedAt: Date | null;
  } | null> {
    return this.prisma.organizationInvite.findUnique({
      where: { token },
      select: { organizationId: true, expiresAt: true, usedAt: true, revokedAt: true },
    });
  }

  /** Locks the invite row, so two Start presses with one link cannot both use it. */
  async lockInviteByToken(tx: Tx, token: string): Promise<InviteRecord | null> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        organization_id: string;
        created_at: Date;
        expires_at: Date;
        used_at: Date | null;
        revoked_at: Date | null;
      }[]
    >`SELECT id, organization_id, created_at, expires_at, used_at, revoked_at
      FROM organization_invites WHERE token = ${token} FOR UPDATE`;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          organizationId: row.organization_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
          revokedAt: row.revoked_at,
        }
      : null;
  }

  async markInviteUsed(tx: Tx, id: string, usedAt: Date, telegramUserId: bigint): Promise<void> {
    await tx.organizationInvite.update({
      where: { id },
      data: { usedAt, usedByTelegramUserId: telegramUserId },
    });
  }

  /** How many membership rows (current or former) an organization ever had. */
  countMemberships(tx: Tx, organizationId: string): Promise<number> {
    return tx.organizationMember.count({ where: { organizationId } });
  }

  async list(filter: OrganizationFilter): Promise<OrganizationWithMembers[]> {
    const rows = await this.prisma.organization.findMany({
      where: {
        ...NOT_MERGED,
        archivedAt: filter.archived ? { not: null } : null,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.label ? { label: filter.label } : {}),
        ...(filter.search
          ? { name: { contains: escapeLike(filter.search), mode: 'insensitive' } }
          : {}),
      },
      include: WITH_MEMBERS,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toView);
  }

  /**
   * The organizations an order may be created for now: ACTIVE, not archived, not merged; by type and
   * label, and by name OR by one of the given CURRENT members. `ids` limits it to those organizations.
   */
  async findOrderable(
    filter: {
      type?: OrganizationType;
      label?: OrganizationLabel;
      search?: { text: string; memberUserIds: readonly string[] };
      ids?: readonly string[];
    },
    take: number,
  ): Promise<OrganizationWithMembers[]> {
    const search = filter.search;
    const rows = await this.prisma.organization.findMany({
      where: {
        ...NOT_MERGED,
        archivedAt: null,
        status: 'ACTIVE',
        ...(filter.ids ? { id: { in: [...filter.ids] } } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.label ? { label: filter.label } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: escapeLike(search.text), mode: 'insensitive' } },
                {
                  members: {
                    some: { status: 'ACTIVE', userId: { in: [...search.memberUserIds] } },
                  },
                },
              ],
            }
          : {}),
      },
      include: WITH_MEMBERS,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
    });
    return rows.map(toView);
  }

  async findIdsByName(search: string, take: number): Promise<string[]> {
    const rows = await this.prisma.organization.findMany({
      where: { name: { contains: escapeLike(search), mode: 'insensitive' }, ...NOT_MERGED },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    return rows.map((row) => row.id);
  }

  /** Row lock: serializes membership changes of one organization and fixes the audit "before". */
  async lockById(tx: Tx, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM organizations WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    return rows.length > 0;
  }

  async updateFields(
    tx: Tx,
    id: string,
    data: Prisma.OrganizationUncheckedUpdateInput & { updatedAt: Date },
  ): Promise<void> {
    await tx.organization.update({ where: { id }, data });
  }

  /** The person's ACTIVE membership in ANY organization (one at most, by a partial unique index). */
  async findActiveMembershipOfUser(
    tx: Tx,
    userId: string,
  ): Promise<{ organizationId: string } | null> {
    const row = await tx.organizationMember.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { organizationId: true },
    });
    return row;
  }

  /** Creates the membership, or brings a LEFT one back (the pair is unique). */
  async activateMember(
    tx: Tx,
    data: { organizationId: string; userId: string; role: OrganizationRole; now: Date },
  ): Promise<void> {
    await tx.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId: data.organizationId, userId: data.userId },
      },
      create: {
        organizationId: data.organizationId,
        userId: data.userId,
        role: data.role,
        joinedAt: data.now,
      },
      update: { role: data.role, status: 'ACTIVE', joinedAt: data.now, leftAt: null },
    });
  }

  async setMemberRole(
    tx: Tx,
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<void> {
    await tx.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { role },
    });
  }

  async markMemberLeft(tx: Tx, organizationId: string, userId: string, now: Date): Promise<void> {
    await tx.organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { status: 'LEFT', leftAt: now },
    });
  }
}
