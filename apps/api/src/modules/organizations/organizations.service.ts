import { Injectable } from '@nestjs/common';
import {
  priceTierOfLabel,
  uuidSchema,
  type CreateOrganizationRequest,
  type Locale,
  type OrganizationInviteStatus,
  type OrganizationRole,
  type OrganizationType,
  type PriceTier,
  type StaffOrganizationListQuery,
  type UpdateOrganizationRequest,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { mapMembershipGuardError } from '../../common/database/staff-membership-guard.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { enqueueStaffNotice, enqueueUserNotice } from '../../common/outbox/staff-notices.js';
import { AuditService, diffFields, type AuditValue } from '../audit/index.js';
import { IdentityService, type UserSummary } from '../identity/index.js';
import {
  generateInviteToken,
  invitePayload,
  inviteStatusOf,
  inviteTokenOf,
  judgeInvite,
} from './organization-invite.js';
import { OrganizationInviteSettings } from './organization-invite.settings.js';
import { PendingNoticeLimiter } from './pending-notice-limiter.js';
import {
  isTypeChangeable,
  type MemberView,
  type OrganizationView,
  type OrganizationWithMembers,
} from './organization.view.js';
import {
  OrganizationsRepository,
  type InviteRecord,
  type OrganizationContactInfo,
} from './organizations.repository.js';

const ENTITY_TYPE = 'ORGANIZATION';
/** How many organizations a name search hands to another module; a search should be narrower. */
const NAME_SEARCH_LIMIT = 500;

export interface MemberDetail extends MemberView {
  fullName: string;
  phone: string | null;
}

export interface OrganizationDetail {
  organization: OrganizationView;
  members: MemberDetail[];
  invite: { status: OrganizationInviteStatus; expiresAt: Date | null };
  /** PERSON only: the bound person (the ACTIVE shop owner) and their Telegram id (= the chat). */
  boundPerson: { userId: string; fullName: string; telegramUserId: bigint } | null;
}

/** The current invite of an organization, for the staff link. `startPayload` only while PENDING. */
export interface OrganizationInviteLink {
  type: OrganizationType;
  status: OrganizationInviteStatus;
  expiresAt: Date | null;
  startPayload: string | null;
}

/** Where the bot reaches an organization, and whether it may (not an endpoint). */
export interface OrganizationChatTarget {
  /** Null while a staff-created organization is not bound. */
  chatId: string | null;
  active: boolean;
  /** A PERSON: the chat is the person's private chat with the bot. */
  privateChat: boolean;
  priceTier: PriceTier;
}

/** One organization a price post goes to, with ITS tier and where it lands. */
export interface PricePostingRecipient {
  organizationId: string;
  priceTier: PriceTier;
  destination: 'GROUP' | 'PRIVATE';
}

export interface PricePostingPlan {
  recipients: PricePostingRecipient[];
  /** Each organization counted once, in this order of reasons. */
  skipped: { unbound: number; inactive: number; postingOff: number };
}

/** What a Start press with an organization invite did; the bot answers each one differently. */
export type InviteBindOutcome =
  | { kind: 'LINKED'; organizationId: string; organizationName: string }
  /** Unknown, used, revoked or expired link (or not an invite payload at all). */
  | { kind: 'INVALID_LINK' }
  /** A PERSON link used in a group, or a GROUP link in a private chat. The link stays valid. */
  | { kind: 'WRONG_CHAT' }
  /** The person already belongs to another organization (one person = one organization). */
  | { kind: 'ALREADY_MEMBER_ELSEWHERE' }
  /** Staff are never organization members. */
  | { kind: 'STAFF_ACCOUNT' }
  /** A BLOCKED person cannot become a shop owner (like assignShopOwner's USER_BLOCKED). */
  | { kind: 'USER_BLOCKED' }
  /** This group already is another organization; staff decide what to do. */
  | { kind: 'CHAT_TAKEN' };

/** A person pressing Start with an invite, as Telegram reported them (untrusted text, bounded). */
export interface InvitePerson {
  telegramUserId: bigint;
  fullName: string;
  language: Locale;
}

/** A Telegram group event: when it happened (Telegram's clock) and which group. */
export interface TelegramGroupEvent {
  chatId: bigint;
  eventAt: Date;
}

export interface TelegramMemberEvent extends TelegramGroupEvent {
  telegramUserId: bigint;
  fullName: string;
  language: Locale;
}

export interface TelegramMemberLeftEvent extends TelegramGroupEvent {
  telegramUserId: bigint;
}

/** Who added the bot, as Telegram reported it. Untrusted text: bounded before it is stored. */
export interface TelegramAddedBy {
  telegramUserId: bigint;
  name: string;
}

/**
 * The Telegram path can only create (INACTIVE) or deactivate. It never activates: that is a
 * staff decision (owner decision, see the work log).
 */
export interface GroupStatusResult {
  organizationId: string | null;
  outcome: 'CREATED' | 'DEACTIVATED' | 'UNCHANGED' | 'STALE' | 'UNKNOWN_GROUP';
}

/** Typed result of a member signal; a conflict is reported, never thrown, and never moves anyone. */
export type MemberPresenceResult =
  | { kind: 'JOINED' }
  | { kind: 'ALREADY_MEMBER' }
  | { kind: 'IGNORED_STAFF' }
  | { kind: 'UNKNOWN_GROUP' }
  | { kind: 'INACTIVE_GROUP' }
  | { kind: 'STALE' }
  | { kind: 'CONFLICT'; reason: 'ALREADY_MEMBER_ELSEWHERE' };

export type MemberLeftResult =
  { kind: 'LEFT' } | { kind: 'NOT_A_MEMBER' } | { kind: 'UNKNOWN_GROUP' } | { kind: 'STALE' };

const NAME_MAX_LENGTH = 200;

/** A group always has a title in Telegram; the fallback only keeps the column non-blank. */
function normalizeGroupName(title: string, chatId: bigint): string {
  const trimmed = title.trim().slice(0, NAME_MAX_LENGTH);
  return trimmed === '' ? `Telegram group ${chatId}` : trimmed;
}

function normalizePersonName(name: string, telegramUserId: bigint): string {
  const trimmed = name.trim().slice(0, NAME_MAX_LENGTH);
  return trimmed === '' ? `Telegram user ${telegramUserId}` : trimmed;
}

function snapshot({ organization, members }: OrganizationWithMembers): Record<string, AuditValue> {
  const fields: Record<string, AuditValue> = {
    name: organization.name,
    type: organization.type,
    label: organization.label,
    phone: organization.phone,
    // A string: audit values are JSON and a Telegram id does not fit a JS number safely in general.
    telegramChatId: organization.telegramChatId?.toString() ?? null,
    status: organization.status,
    pricePostingEnabled: organization.pricePostingEnabled,
    addedByTelegramUserId: organization.addedBy?.telegramUserId.toString() ?? null,
    addedByName: organization.addedBy?.name ?? null,
  };
  for (const member of members) {
    fields[`members.${member.userId}.role`] = member.role;
    fields[`members.${member.userId}.status`] = member.status;
  }
  return fields;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly pendingNotices: PendingNoticeLimiter = new PendingNoticeLimiter(),
    private readonly inviteSettings: OrganizationInviteSettings = new OrganizationInviteSettings(),
  ) {}

  async listOrganizations(
    actor: Actor,
    query: StaffOrganizationListQuery,
  ): Promise<OrganizationDetail[]> {
    this.assertMayView(actor);
    const rows = await this.repository.list({ ...query, archived: query.archived === 'true' });
    return this.withNames(rows);
  }

  /**
   * For other modules (orders): may this organization place orders? Not an endpoint. A missing
   * organization counts as not active.
   */
  async isActive(id: string): Promise<boolean> {
    return (await this.repository.findById(id))?.organization.status === 'ACTIVE';
  }

  /**
   * For the bot: the id of the ACTIVE organization whose Telegram group this is. Unknown chats count
   * as none (null). Not an endpoint.
   */
  async findActiveOrganizationIdByChat(chatId: bigint): Promise<string | null> {
    const found = await this.repository.findByChatId(chatId);
    return found?.organization.status === 'ACTIVE' ? found.organization.id : null;
  }

  /**
   * For other modules (orders): the name and the shop owner of organizations, by id, to show next
   * to an order. Not an endpoint, so the caller has already authorized the request. Unknown ids
   * are left out of the answer.
   */
  async findContactInfo(ids: readonly string[]): Promise<Map<string, OrganizationContactInfo>> {
    const rows = await this.repository.findContactInfo([...new Set(ids)]);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * For other modules (the staff order search): ids of organizations whose name contains the text,
   * ignoring letter case; at most `NAME_SEARCH_LIMIT`. Not an endpoint: the caller has authorized.
   */
  async findIdsByName(search: string): Promise<string[]> {
    return this.repository.findIdsByName(search, NAME_SEARCH_LIMIT);
  }

  /**
   * For the staff dashboard: how many organizations wait for a manager to activate them. The api
   * keeps no separate "pending" flag, so a new Telegram group and a deactivated one both read as
   * INACTIVE (the same reading as the organizations page).
   */
  async countAwaitingActivation(actor: Actor): Promise<number> {
    this.assertMayView(actor);
    return this.repository.countInactive();
  }

  async getOrganization(actor: Actor, id: string): Promise<OrganizationDetail> {
    this.assertMayView(actor);
    return this.requireDetail(id);
  }

  async updateOrganization(
    actor: Actor,
    id: string,
    input: UpdateOrganizationRequest,
  ): Promise<OrganizationDetail> {
    this.assertMayEdit(actor);
    await this.mutate(actor, id, 'ORGANIZATION_UPDATED', async (tx, before) => {
      // Only what really differs is written: a no-op PATCH must not touch updated_at.
      const current = before.organization;
      const fields = {
        ...(input.name !== undefined && input.name !== current.name ? { name: input.name } : {}),
        ...(input.type !== undefined && input.type !== current.type ? { type: input.type } : {}),
        ...(input.status !== undefined && input.status !== current.status
          ? { status: input.status }
          : {}),
        ...(input.pricePostingEnabled !== undefined &&
        input.pricePostingEnabled !== current.pricePostingEnabled
          ? { pricePostingEnabled: input.pricePostingEnabled }
          : {}),
        // A label change re-tiers only what is priced from now on: orders keep their own tier.
        ...(input.label !== undefined && input.label !== current.label
          ? { label: input.label }
          : {}),
        ...(input.phone !== undefined && input.phone !== current.phone
          ? { phone: input.phone }
          : {}),
      };
      if (Object.keys(fields).length === 0) return false;
      // [C, owner 2026-11-12] a label change after creation is the admin's alone (it re-tiers the
      // organization's prices); a PATCH that keeps the label as it is needs no such right.
      if (fields.label !== undefined && !can(actor, 'CHANGE_ORGANIZATION_LABEL')) {
        throw new ForbiddenError('Only an administrator may change the label');
      }
      // The bound chat is what the type describes: isTypeChangeable is the one rule. The open
      // invite stays valid; the link is built from the new type and the bot checks it on use.
      if (fields.type !== undefined && !isTypeChangeable(before)) {
        throw new ConflictError(
          'The organization is already linked to a Telegram chat; its type cannot change',
          'ORGANIZATION_ALREADY_LINKED',
        );
      }
      // Nobody could be reached or order: the invite activates it when the chat is bound.
      if (fields.status === 'ACTIVE' && current.telegramChatId === null) {
        throw new ConflictError(
          'The organization has no Telegram chat yet; its invite link activates it',
          'ORGANIZATION_NOT_LINKED',
        );
      }
      await this.repository.updateFields(tx, id, { ...fields, updatedAt: this.clock.now() });
      return true;
    });
    return this.requireDetail(id);
  }

  /**
   * Staff create an organization [C, owner 2026-11-11]: a GROUP or a PERSON, label STANDARD unless
   * given. It starts INACTIVE without a chat, with a one-time invite link [P]: whoever uses it binds
   * the chat and the organization becomes ACTIVE. One transaction with its audit row.
   */
  async createOrganization(
    actor: Actor,
    input: CreateOrganizationRequest,
  ): Promise<{ detail: OrganizationDetail; invite: OrganizationInviteLink }> {
    this.assertMayEdit(actor);
    const id = await this.repository.transaction(async (tx) => {
      const now = this.clock.now();
      const organizationId = await this.repository.createByStaff(tx, {
        type: input.type,
        name: input.name,
        label: input.label,
        phone: input.phone,
        createdByUserId: actor.userId,
        now,
      });
      const expiresAt = await this.insertInvite(tx, organizationId, actor.userId, now);
      const after = await this.repository.findById(organizationId, tx);
      if (!after) throw new NotFoundError('Organization not found');
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY_TYPE,
        entityId: organizationId,
        action: 'ORGANIZATION_CREATED',
        changes: {
          ...diffFields({}, snapshot(after)),
          // The token is a secret: the audit row says only that a link exists and until when.
          inviteExpiresAt: { from: null, to: expiresAt.toISOString() },
        },
      });
      return organizationId;
    });
    return { detail: await this.requireDetail(id), invite: await this.inviteLinkOf(id) };
  }

  /**
   * A new invite link [P]: the open one is revoked in the same transaction, so the old link stops
   * working at once. Refused once a chat is bound (nothing left to invite to).
   */
  async regenerateInvite(actor: Actor, id: string): Promise<OrganizationInviteLink> {
    this.assertMayEdit(actor);
    await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockById(tx, id))) {
        throw new NotFoundError('Organization not found');
      }
      const before = await this.repository.findById(id, tx);
      if (!before) throw new NotFoundError('Organization not found');
      assertNotArchived(before);
      if (before.organization.telegramChatId !== null) {
        throw new ConflictError(
          'The organization is already linked to a Telegram chat',
          'ORGANIZATION_ALREADY_LINKED',
        );
      }
      const now = this.clock.now();
      const revoked = await this.repository.revokeOpenInvites(tx, id, now);
      const expiresAt = await this.insertInvite(tx, id, actor.userId, now);
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'ORGANIZATION_INVITE_REGENERATED',
        changes: {
          inviteExpiresAt: {
            from: before.organization.openInvite?.expiresAt.toISOString() ?? null,
            to: expiresAt.toISOString(),
          },
          revokedInviteCount: { from: null, to: revoked },
        },
      });
    });
    return this.inviteLinkOf(id);
  }

  /**
   * The current invite for the staff link. Editing permission: the link is the key to the
   * organization, so a read-only role (purchasing manager) does not get it.
   */
  async getInviteLink(actor: Actor, id: string): Promise<OrganizationInviteLink> {
    this.assertMayEdit(actor);
    return this.inviteLinkOf(id);
  }

  /**
   * For other modules (pricing, orders): the price tier of an organization from its CURRENT label
   * (PRICE_TIER_OF_LABEL). An unknown organization gets STANDARD. Not an endpoint.
   */
  async findPriceTier(id: string): Promise<PriceTier> {
    // An id that is no uuid names no organization (the column would refuse it).
    if (!uuidSchema.safeParse(id).success) return 'STANDARD';
    const label = await this.repository.findLabel(id);
    return label === null ? 'STANDARD' : priceTierOfLabel(label);
  }

  private async insertInvite(
    tx: Tx,
    organizationId: string,
    createdByUserId: string,
    now: Date,
  ): Promise<Date> {
    const expiresAt = new Date(now.getTime() + this.inviteSettings.ttlSeconds * 1000);
    await this.repository.insertInvite(tx, {
      organizationId,
      token: generateInviteToken(),
      createdByUserId,
      createdAt: now,
      expiresAt,
    });
    return expiresAt;
  }

  private async inviteLinkOf(id: string): Promise<OrganizationInviteLink> {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundError('Organization not found');
    const { status, expiresAt } = inviteStatusOf(row.organization, this.clock.now());
    const open = status === 'PENDING' ? await this.repository.findOpenInviteToken(id) : null;
    return {
      type: row.organization.type,
      status,
      expiresAt,
      startPayload: open === null ? null : invitePayload(open.token),
    };
  }

  /**
   * Makes the person the shop owner: promotes a current member, brings back a former one, or
   * adds a person who is in no organization yet (the bot's group-join flow will normally have
   * created the membership). The current owner is never replaced silently: remove them first.
   */
  async assignShopOwner(actor: Actor, id: string, userId: string): Promise<OrganizationDetail> {
    this.assertMayEdit(actor);
    const person = (await this.identity.findSummaries([userId])).get(userId);
    if (!person) throw new NotFoundError('User not found');
    if (person.staffRoles.length > 0) {
      throw new ConflictError('A staff member cannot be an organization member', 'MEMBER_IS_STAFF');
    }

    // A blocked person could not use the role and an inactive organization cannot place orders:
    // both would only create a shop owner nobody can act as.
    if (person.status === 'BLOCKED') {
      throw new ConflictError('A blocked user cannot become a shop owner', 'USER_BLOCKED');
    }

    await this.mutate(actor, id, 'ORGANIZATION_SHOP_OWNER_ASSIGNED', async (tx, before) => {
      assertNotPerson(before);
      if (before.organization.status !== 'ACTIVE') {
        throw new ConflictError(
          'An inactive organization cannot get a shop owner',
          'ORGANIZATION_INACTIVE',
        );
      }
      const owner = before.members.find((m) => m.status === 'ACTIVE' && m.role === 'SHOP_OWNER');
      if (owner) {
        if (owner.userId === userId) return false;
        throw new ConflictError('The organization already has a shop owner', 'SHOP_OWNER_EXISTS');
      }
      const own = before.members.find((m) => m.userId === userId);
      if (own?.status !== 'ACTIVE') {
        const elsewhere = await this.repository.findActiveMembershipOfUser(tx, userId);
        if (elsewhere) {
          throw new ConflictError(
            'The person is already an active member of an organization',
            'ALREADY_MEMBER_ELSEWHERE',
          );
        }
      }
      await this.repository.activateMember(tx, {
        organizationId: id,
        userId,
        role: 'SHOP_OWNER',
        now: this.clock.now(),
      });
      return true;
    });
    return this.requireDetail(id);
  }

  /** Demotes the shop owner to SELLER: the person stays a member and keeps seeing the orders. */
  async removeShopOwner(actor: Actor, id: string): Promise<OrganizationDetail> {
    this.assertMayEdit(actor);
    await this.mutate(actor, id, 'ORGANIZATION_SHOP_OWNER_REMOVED', async (tx, before) => {
      assertNotPerson(before);
      const owner = before.members.find((m) => m.status === 'ACTIVE' && m.role === 'SHOP_OWNER');
      if (!owner) throw new NotFoundError('The organization has no shop owner');
      await this.repository.setMemberRole(tx, id, owner.userId, 'SELLER');
      return true;
    });
    return this.requireDetail(id);
  }

  async changeMemberRole(
    actor: Actor,
    id: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<OrganizationDetail> {
    this.assertMayEdit(actor);
    await this.mutate(actor, id, 'ORGANIZATION_MEMBER_ROLE_CHANGED', async (tx, before) => {
      assertNotPerson(before);
      const member = this.requireActiveMember(before, userId);
      if (member.role === role) return false;
      const owner = before.members.find((m) => m.status === 'ACTIVE' && m.role === 'SHOP_OWNER');
      if (role === 'SHOP_OWNER' && owner) {
        throw new ConflictError('The organization already has a shop owner', 'SHOP_OWNER_EXISTS');
      }
      await this.repository.setMemberRole(tx, id, userId, role);
      return true;
    });
    return this.requireDetail(id);
  }

  /**
   * Idempotent: a member who already left stays as they are (their original leave time is kept).
   * A PERSON whose bound person leaves [P, review 2026-11-12] becomes INACTIVE and loses its chat
   * in the same transaction: nobody is reached any more, and staff can send a new invite link.
   */
  async markMemberLeft(actor: Actor, id: string, userId: string): Promise<OrganizationDetail> {
    this.assertMayEdit(actor);
    await this.mutate(actor, id, 'ORGANIZATION_MEMBER_LEFT', async (tx, before) => {
      const member = before.members.find((m) => m.userId === userId);
      if (!member) throw new NotFoundError('Member not found');
      if (member.status === 'LEFT') return false;
      const now = this.clock.now();
      await this.repository.markMemberLeft(tx, id, userId, now);
      if (before.organization.type === 'PERSON' && member.role === 'SHOP_OWNER') {
        await this.repository.updateFields(tx, id, {
          status: 'INACTIVE',
          telegramChatId: null,
          updatedAt: now,
        });
      }
      return true;
    });
    return this.requireDetail(id);
  }

  /**
   * "Deleting" an organization [C, owner 2026-11-13]: the admin archives it, never a hard delete
   * (its orders, payments, member history and notifications stay). One transaction: archived_at/by
   * set, status INACTIVE, the open invite revoked, and [P] every ACTIVE membership ended (LEFT) and
   * the Telegram chat released, so its people and its chat are free for another organization (one
   * person = one organization; a chat belongs to one organization). One audit row with exactly
   * what changed. Orders and payments are untouched. A repeat is a no-op [P].
   */
  async archiveOrganization(actor: Actor, id: string): Promise<OrganizationDetail> {
    this.assertMayArchive(actor);
    await this.repository.transaction(async (tx) => {
      const before = await this.lockAndRead(tx, id);
      if (before.organization.archivedAt !== null) return;
      const now = this.clock.now();
      const revoked = await this.repository.revokeOpenInvites(tx, id, now);
      for (const member of before.members.filter((m) => m.status === 'ACTIVE')) {
        await this.repository.markMemberLeft(tx, id, member.userId, now);
      }
      await this.repository.updateFields(tx, id, {
        status: 'INACTIVE',
        telegramChatId: null,
        archivedAt: now,
        archivedByUserId: actor.userId,
        updatedAt: now,
      });
      const after = await this.repository.findById(id, tx);
      if (!after) throw new NotFoundError('Organization not found');
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'ORGANIZATION_ARCHIVED',
        changes: {
          // Status (only if it was ACTIVE), the released chat and each ended membership.
          ...diffFields(snapshot(before), snapshot(after)),
          archivedAt: { from: null, to: now.toISOString() },
          archivedByUserId: { from: null, to: actor.userId },
          ...(revoked > 0 ? { revokedInviteCount: { from: null, to: revoked } } : {}),
        },
      });
    });
    return this.requireDetail(id);
  }

  /**
   * Back from the archive (admin only). It comes back INACTIVE and unlinked [P]: archiving ended its
   * memberships and released its chat, so staff bind it again with a new invite link. A restore of
   * a non-archived one is a no-op [P].
   */
  async restoreOrganization(actor: Actor, id: string): Promise<OrganizationDetail> {
    this.assertMayArchive(actor);
    await this.repository.transaction(async (tx) => {
      const before = await this.lockAndRead(tx, id);
      const { archivedAt, archivedByUserId } = before.organization;
      if (archivedAt === null) return;
      await this.repository.updateFields(tx, id, {
        archivedAt: null,
        archivedByUserId: null,
        updatedAt: this.clock.now(),
      });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'ORGANIZATION_RESTORED',
        changes: {
          archivedAt: { from: archivedAt.toISOString(), to: null },
          archivedByUserId: { from: archivedByUserId, to: null },
        },
      });
    });
    return this.requireDetail(id);
  }

  // --------------------------------------- Telegram group events (the bot, no actor)

  /**
   * For the price list post (pricing module, not an endpoint; the caller authorizes): who gets the
   * file [C, owner 2026-11-11]. Every bound, ACTIVE organization with price posting on, each with
   * the tier of its label; a GROUP in its group chat, a PERSON in the person's private chat. The
   * rest is counted by reason: not bound yet [P], INACTIVE, posting off. Pass the caller's
   * transaction so the plan and the outbox rows written from it are one snapshot.
   */
  async findPricePostingPlan(db?: DbClient): Promise<PricePostingPlan> {
    const plan: PricePostingPlan = {
      recipients: [],
      skipped: { unbound: 0, inactive: 0, postingOff: 0 },
    };
    for (const candidate of await this.repository.findPricePostingCandidates(db)) {
      // A PERSON counts as bound only while its person can be reached (blocked, left: unbound).
      const bound =
        candidate.bound &&
        (candidate.type !== 'PERSON' || (await this.isPersonReachable(candidate.id, db)));
      if (!bound) plan.skipped.unbound += 1;
      else if (candidate.status !== 'ACTIVE') plan.skipped.inactive += 1;
      else if (!candidate.pricePostingEnabled) plan.skipped.postingOff += 1;
      else {
        plan.recipients.push({
          organizationId: candidate.id,
          priceTier: priceTierOfLabel(candidate.label),
          destination: candidate.type === 'PERSON' ? 'PRIVATE' : 'GROUP',
        });
      }
    }
    return plan;
  }

  /**
   * For the notification sender: the Telegram chat of an organization (a group, or a PERSON's
   * private chat), whether it may be messaged, and its CURRENT price tier. Null for an unknown
   * organization. Not an endpoint.
   */
  async findChatTarget(id: string): Promise<OrganizationChatTarget | null> {
    const row = await this.repository.findById(id);
    if (!row) return null;
    const { organization } = row;
    // A PERSON's chat is used only while its bound person can be reached [review 2026-11-12].
    const reachable = organization.type !== 'PERSON' || (await this.personReachable(row));
    return {
      chatId: reachable ? (organization.telegramChatId?.toString() ?? null) : null,
      active: organization.status === 'ACTIVE',
      privateChat: organization.type === 'PERSON',
      priceTier: priceTierOfLabel(organization.label),
    };
  }

  private async isPersonReachable(id: string, db?: DbClient): Promise<boolean> {
    const row = await this.repository.findById(id, db);
    return row !== null && (await this.personReachable(row));
  }

  /**
   * A PERSON is reachable only while its chat belongs to its ACTIVE shop owner, an ACTIVE customer
   * (never staff) whose Telegram id is the chat. A blocked person, one who left, or one replaced by
   * staff gets no price file and no order message [review 2026-11-12].
   */
  private async personReachable(row: OrganizationWithMembers): Promise<boolean> {
    const chat = row.organization.telegramChatId;
    if (chat === null) return false;
    const owner = row.members.find((m) => m.status === 'ACTIVE' && m.role === 'SHOP_OWNER');
    if (!owner) return false;
    const person = await this.identity.findTelegramPerson(chat);
    return (
      person !== null &&
      person.userId === owner.userId &&
      person.status === 'ACTIVE' &&
      person.staffRoles.length === 0
    );
  }

  /**
   * The bind paths lock in the same order as regenerateInvite: the organization first, then the
   * invite row (re-read under the lock). Returns the locked invite and the organization, or null
   * when the link does not bind (unknown, used, revoked, expired, or its organization is bound).
   */
  private async lockForBinding(
    tx: Tx,
    token: string,
    now: Date,
  ): Promise<{ invite: InviteRecord; before: OrganizationWithMembers } | null> {
    const seen = await this.repository.findInviteByToken(token);
    if (seen === null || judgeInvite(seen, now) !== 'VALID') return null;
    if (!(await this.repository.lockById(tx, seen.organizationId))) return null;
    const invite = await this.repository.lockInviteByToken(tx, token);
    if (
      invite === null ||
      invite.organizationId !== seen.organizationId ||
      judgeInvite(invite, now) !== 'VALID'
    ) {
      return null;
    }
    const before = await this.repository.findById(invite.organizationId, tx);
    // No archived check needed: archiving revokes the open invite under this same organization
    // lock, and an archived organization gets no new invite, so a VALID invite (re-judged above
    // under the lock) never belongs to an archived organization.
    if (!before || before.organization.telegramChatId !== null) return null;
    return { invite, before };
  }

  /**
   * `/start org_<token>` in a private chat [P]: binds a PERSON organization to the person who
   * pressed Start. The person's Telegram account becomes the organization's member and shop owner,
   * the private chat becomes its chat, and the organization becomes ACTIVE; the invite is used up.
   * One transaction with the audit row (system source TELEGRAM) and a notice to the staff member
   * who created the organization. A link of the wrong kind, a person of another organization or a
   * staff member is refused and leaves the link valid.
   */
  async bindPersonByInvite(payload: string, person: InvitePerson): Promise<InviteBindOutcome> {
    const token = inviteTokenOf(payload);
    if (token === null) return { kind: 'INVALID_LINK' };
    // Checked before anything is written: a made-up or dead link must not create a user row.
    if (judgeInvite(await this.repository.findInviteByToken(token), this.clock.now()) !== 'VALID') {
      return { kind: 'INVALID_LINK' };
    }
    const { person: user } = await this.identity.ensureTelegramUser({
      telegramUserId: person.telegramUserId,
      fullName: normalizePersonName(person.fullName, person.telegramUserId),
      language: person.language,
    });
    if (user.staffRoles.length > 0) return { kind: 'STAFF_ACCOUNT' };
    // Like assignShopOwner: a blocked person cannot become a shop owner.
    if (user.status === 'BLOCKED') return { kind: 'USER_BLOCKED' };
    try {
      return await this.repository.transaction(async (tx): Promise<InviteBindOutcome> => {
        const now = this.clock.now();
        const locked = await this.lockForBinding(tx, token, now);
        if (locked === null) return { kind: 'INVALID_LINK' };
        const { invite, before } = locked;
        if (before.organization.type !== 'PERSON') return { kind: 'WRONG_CHAT' };
        if (await this.repository.findActiveMembershipOfUser(tx, user.userId)) {
          return { kind: 'ALREADY_MEMBER_ELSEWHERE' };
        }
        // A former PERSON organization of this account still holds the chat: staff sort it out.
        if (await this.repository.findByChatId(person.telegramUserId, tx)) {
          return { kind: 'ALREADY_MEMBER_ELSEWHERE' };
        }
        const id = before.organization.id;
        await this.repository.markInviteUsed(tx, invite.id, now, person.telegramUserId);
        await this.repository.updateFields(tx, id, {
          telegramChatId: person.telegramUserId,
          status: 'ACTIVE',
          telegramStatusEventAt: now,
          updatedAt: now,
        });
        await this.repository.activateMember(tx, {
          organizationId: id,
          userId: user.userId,
          role: 'SHOP_OWNER',
          now,
        });
        await this.recordBound(tx, before, invite.id, person.telegramUserId, now);
        return { kind: 'LINKED', organizationId: id, organizationName: before.organization.name };
      });
    } catch (error) {
      const mapped = mapMembershipGuardError(error);
      // Two presses raced past the checks: the database guards answer with these.
      if (mapped instanceof ConflictError && mapped.reason === 'ALREADY_MEMBER_ELSEWHERE') {
        return { kind: 'ALREADY_MEMBER_ELSEWHERE' };
      }
      if (isUniqueViolation(error)) return { kind: 'ALREADY_MEMBER_ELSEWHERE' };
      throw mapped;
    }
  }

  /**
   * `/start@bot org_<token>` in a group, sent by Telegram right after the bot was added through a
   * `?startgroup=` link [P]: binds the group to the staff-created GROUP organization and activates
   * it. Telegram reports the bot's arrival first, so the bot has usually just registered the group
   * as a new INACTIVE organization: when that one is untouched (registered after this organization
   * was made, never had a member) it is retired (chat cleared, marked merged into the staff-created
   * one, both audited) and the staff-created organization takes the chat. Any other organization
   * already on the chat is never merged: the answer is CHAT_TAKEN and staff decide.
   */
  async bindGroupByInvite(
    payload: string,
    group: { chatId: bigint; title: string; eventAt: Date; addedBy: TelegramAddedBy },
  ): Promise<InviteBindOutcome> {
    const token = inviteTokenOf(payload);
    if (token === null) return { kind: 'INVALID_LINK' };
    try {
      return await this.repository.transaction(async (tx): Promise<InviteBindOutcome> => {
        const now = this.clock.now();
        const locked = await this.lockForBinding(tx, token, now);
        if (locked === null) return { kind: 'INVALID_LINK' };
        const { invite, before } = locked;
        if (before.organization.type !== 'GROUP') return { kind: 'WRONG_CHAT' };

        const existing = await this.repository.findByChatId(group.chatId, tx);
        if (existing) {
          const retired = await this.retireFreshGroup(tx, existing, before.organization);
          if (!retired) return { kind: 'CHAT_TAKEN' };
        }
        const id = before.organization.id;
        const addedBy = {
          telegramUserId: group.addedBy.telegramUserId,
          name: normalizePersonName(group.addedBy.name, group.addedBy.telegramUserId),
        };
        await this.repository.markInviteUsed(tx, invite.id, now, addedBy.telegramUserId);
        await this.repository.updateFields(tx, id, {
          telegramChatId: group.chatId,
          status: 'ACTIVE',
          telegramStatusEventAt: group.eventAt,
          addedByTelegramUserId: addedBy.telegramUserId,
          addedByName: addedBy.name,
          updatedAt: now,
        });
        await this.recordBound(tx, before, invite.id, addedBy.telegramUserId, now);
        return { kind: 'LINKED', organizationId: id, organizationName: before.organization.name };
      });
    } catch (error) {
      // The chat was bound elsewhere between the read and the write.
      if (isUniqueViolation(error)) return { kind: 'CHAT_TAKEN' };
      throw error;
    }
  }

  /**
   * Retires the organization the bot registered for a group after the staff-created one was made
   * (so also after an earlier, expired try with a link regenerated since). Only an untouched one
   * qualifies; returns false (nothing written) otherwise.
   */
  private async retireFreshGroup(
    tx: Tx,
    existing: OrganizationWithMembers,
    into: { id: string; createdAt: Date },
  ): Promise<boolean> {
    const intoId = into.id;
    const org = existing.organization;
    if (
      org.type !== 'GROUP' ||
      org.createdByUserId !== null ||
      org.status !== 'INACTIVE' ||
      org.createdAt.getTime() < into.createdAt.getTime()
    ) {
      return false;
    }
    if (!(await this.repository.lockById(tx, org.id))) return false;
    if ((await this.repository.countMemberships(tx, org.id)) > 0) return false;
    await this.repository.updateFields(tx, org.id, {
      telegramChatId: null,
      mergedIntoOrganizationId: intoId,
      updatedAt: this.clock.now(),
    });
    await this.audit.recordSystem(tx, {
      systemSource: 'TELEGRAM',
      entityType: ENTITY_TYPE,
      entityId: org.id,
      action: 'TELEGRAM_ORGANIZATION_MERGED_INTO_INVITED',
      changes: {
        telegramChatId: { from: org.telegramChatId?.toString() ?? null, to: null },
        mergedIntoOrganizationId: { from: null, to: intoId },
      },
    });
    return true;
  }

  /** The audit row of a binding and the notice to the staff member who created the organization. */
  private async recordBound(
    tx: Tx,
    before: OrganizationWithMembers,
    inviteId: string,
    telegramUserId: bigint,
    now: Date,
  ): Promise<void> {
    const id = before.organization.id;
    const after = await this.repository.findById(id, tx);
    if (!after) throw new NotFoundError('Organization not found');
    await this.audit.recordSystem(tx, {
      systemSource: 'TELEGRAM',
      entityType: ENTITY_TYPE,
      entityId: id,
      action: 'TELEGRAM_ORGANIZATION_LINKED',
      changes: {
        ...diffFields(snapshot(before), snapshot(after)),
        inviteId: { from: null, to: inviteId },
        linkedByTelegramUserId: { from: null, to: telegramUserId.toString() },
      },
    });
    const creator = before.organization.createdByUserId;
    if (creator !== null) {
      await enqueueUserNotice(
        tx,
        {
          type: 'ORGANIZATION_LINKED',
          userId: creator,
          dedupeKey: `organization-linked:${id}`,
          payload: { organizationName: before.organization.name },
        },
        now,
      );
    }
  }

  /**
   * The bot was added to a group: creates the organization once (name = group title, INACTIVE,
   * price posting off, who added the bot recorded) and tells managers and admins. For a group
   * that is already known NOTHING changes except an audit row: only staff activate an
   * organization (a bot removed and added again stays INACTIVE). Idempotent under Telegram
   * retries and ordered by the event time. Audited as the system source TELEGRAM.
   */
  async registerTelegramGroup(
    input: TelegramGroupEvent & { title: string; addedBy: TelegramAddedBy | null },
  ): Promise<GroupStatusResult> {
    const name = normalizeGroupName(input.title, input.chatId);
    try {
      return await this.registerGroupOnce(input, name);
    } catch (error) {
      // Two updates created the same group at once: the second one finds it.
      if (isUniqueViolation(error)) return this.registerGroupOnce(input, name);
      throw error;
    }
  }

  /** The bot left or was removed: the organization becomes INACTIVE (never deleted). */
  async deactivateTelegramGroup(input: TelegramGroupEvent): Promise<GroupStatusResult> {
    return this.deactivateKnownGroup(input);
  }

  /** The group title changed: the organization name follows it. No-op for unknown groups. */
  async renameTelegramGroup(
    input: TelegramGroupEvent & { title: string },
  ): Promise<{ outcome: 'RENAMED' | 'UNCHANGED' | 'UNKNOWN_GROUP' }> {
    const known = await this.repository.findByChatId(input.chatId);
    if (!known) return { outcome: 'UNKNOWN_GROUP' };
    const name = normalizeGroupName(input.title, input.chatId);
    const id = known.organization.id;
    let renamed = false;
    await this.mutateAsTelegram(id, 'TELEGRAM_ORGANIZATION_RENAMED', async (tx, before) => {
      if (before.organization.name === name) return false;
      await this.repository.updateFields(tx, id, { name, updatedAt: this.clock.now() });
      renamed = true;
      return true;
    });
    return { outcome: renamed ? 'RENAMED' : 'UNCHANGED' };
  }

  /**
   * A basic group was upgraded to a supergroup: Telegram gives it a NEW chat id. The organization
   * keeps its history and moves to the new id. If an organization for the new id already exists
   * (its "bot added" update came first) nothing is merged automatically: the result says so and
   * staff decide.
   */
  async migrateTelegramChat(
    input: TelegramGroupEvent & { toChatId: bigint },
  ): Promise<{ outcome: 'MIGRATED' | 'UNKNOWN_GROUP' | 'TARGET_EXISTS' }> {
    const known = await this.repository.findByChatId(input.chatId);
    if (!known) return { outcome: 'UNKNOWN_GROUP' };
    if (await this.repository.findByChatId(input.toChatId)) return { outcome: 'TARGET_EXISTS' };
    try {
      await this.mutateAsTelegram(
        known.organization.id,
        'TELEGRAM_ORGANIZATION_CHAT_MIGRATED',
        async (tx) => {
          await this.repository.updateFields(tx, known.organization.id, {
            telegramChatId: input.toChatId,
            updatedAt: this.clock.now(),
          });
          return true;
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: 'TARGET_EXISTS' };
      throw error;
    }
    return { outcome: 'MIGRATED' };
  }

  /**
   * A person is in a group (joined, or wrote a message): records an ACTIVE membership, role
   * SELLER (staff assign a shop owner later). Staff are never members; a person who is already
   * an ACTIVE member of ANOTHER organization is not moved (conflict result, the first one is
   * kept: one person = one organization). Idempotent and ordered by the event time.
   */
  async recordTelegramMemberPresent(input: TelegramMemberEvent): Promise<MemberPresenceResult> {
    const group = await this.repository.findByChatId(input.chatId);
    if (!group) return { kind: 'UNKNOWN_GROUP' };
    if (group.organization.status !== 'ACTIVE') return { kind: 'INACTIVE_GROUP' };
    const { person } = await this.identity.ensureTelegramUser({
      telegramUserId: input.telegramUserId,
      fullName: normalizePersonName(input.fullName, input.telegramUserId),
      language: input.language,
    });
    if (person.staffRoles.length > 0) return { kind: 'IGNORED_STAFF' };

    const id = group.organization.id;
    // The common case in a busy group (every message is a signal): no transaction, no lock.
    if (person.membership?.organizationId === id) return { kind: 'ALREADY_MEMBER' };
    // Assigned inside the callback below; the cast keeps TypeScript from narrowing it to the initial value.
    let result = { kind: 'ALREADY_MEMBER' } as MemberPresenceResult;
    try {
      await this.mutateAsTelegram(id, 'TELEGRAM_MEMBER_JOINED', async (tx, before) => {
        if (before.organization.status !== 'ACTIVE') {
          result = { kind: 'INACTIVE_GROUP' };
          return false;
        }
        const own = before.members.find((m) => m.userId === person.userId);
        if (own?.status === 'ACTIVE') return false;
        if (own?.leftAt && own.leftAt.getTime() > input.eventAt.getTime()) {
          result = { kind: 'STALE' };
          return false;
        }
        const elsewhere = await this.repository.findActiveMembershipOfUser(tx, person.userId);
        if (elsewhere) {
          result = { kind: 'CONFLICT', reason: 'ALREADY_MEMBER_ELSEWHERE' };
          return false;
        }
        await this.repository.activateMember(tx, {
          organizationId: id,
          userId: person.userId,
          role: 'SELLER',
          now: input.eventAt,
        });
        result = { kind: 'JOINED' };
        return true;
      });
    } catch (error) {
      // A race past the checks above: the database guards answer with the same conflicts.
      if (error instanceof ConflictError && error.reason === 'ALREADY_MEMBER_ELSEWHERE') {
        await this.reportMembershipConflict(group.organization, input);
        return { kind: 'CONFLICT', reason: 'ALREADY_MEMBER_ELSEWHERE' };
      }
      if (error instanceof ConflictError && error.reason === 'MEMBER_IS_STAFF') {
        return { kind: 'IGNORED_STAFF' };
      }
      throw error;
    }
    if (result.kind === 'CONFLICT') await this.reportMembershipConflict(group.organization, input);
    return result;
  }

  /**
   * The second organization of a person: staff must know, because the person silently does not
   * get access. One notice (and one audit row) per person and group, however many messages the
   * person writes afterwards.
   */
  private async reportMembershipConflict(
    organization: OrganizationView,
    input: TelegramMemberEvent,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const created = await enqueueStaffNotice(
        tx,
        {
          type: 'MEMBERSHIP_CONFLICT',
          dedupeKey: `membership-conflict:${organization.id}:${input.telegramUserId}`,
          payload: {
            personName: normalizePersonName(input.fullName, input.telegramUserId),
            telegramUserId: input.telegramUserId.toString(),
            organizationName: organization.name,
          },
        },
        this.clock.now(),
      );
      if (created === 0) return;
      await this.audit.recordSystem(tx, {
        systemSource: 'TELEGRAM',
        entityType: ENTITY_TYPE,
        entityId: organization.id,
        action: 'TELEGRAM_MEMBER_CONFLICT',
        changes: { conflictTelegramUserId: { from: null, to: input.telegramUserId.toString() } },
      });
    });
  }

  /** A person left or was removed from a group: their membership there is marked LEFT. */
  async recordTelegramMemberLeft(input: TelegramMemberLeftEvent): Promise<MemberLeftResult> {
    const group = await this.repository.findByChatId(input.chatId);
    if (!group) return { kind: 'UNKNOWN_GROUP' };
    const person = await this.identity.findTelegramPerson(input.telegramUserId);
    if (!person) return { kind: 'NOT_A_MEMBER' };
    let result: MemberLeftResult = { kind: 'NOT_A_MEMBER' };
    await this.mutateAsTelegram(
      group.organization.id,
      'TELEGRAM_MEMBER_LEFT',
      async (tx, before) => {
        const own = before.members.find((m) => m.userId === person.userId);
        if (!own || own.status === 'LEFT') return false;
        if (own.joinedAt.getTime() > input.eventAt.getTime()) {
          result = { kind: 'STALE' };
          return false;
        }
        await this.repository.markMemberLeft(
          tx,
          group.organization.id,
          person.userId,
          input.eventAt,
        );
        result = { kind: 'LEFT' };
        return true;
      },
    );
    return result;
  }

  /**
   * For the dispatcher before it removes someone: when the person's ACTIVE membership in this
   * organization started, or null when they are not an active member.
   */
  async findActiveMembershipStart(organizationId: string, userId: string): Promise<Date | null> {
    const row = await this.repository.findById(organizationId);
    const member = row?.members.find((m) => m.userId === userId);
    return member && member.status === 'ACTIVE' ? member.joinedAt : null;
  }

  /**
   * The bot has just removed a blocked person from the group (Telegram accepted the request):
   * the membership becomes LEFT, in the same transaction as the audit row that says why, who
   * asked and when (hard rule 12). Called by the outbox dispatcher ONLY after a success.
   * Idempotent: a member who already left keeps their original leave time and nothing is written.
   */
  async recordMemberRemovedByBot(input: {
    organizationId: string;
    userId: string;
    requestedByUserId: string;
    requestedAt: string;
    reason: 'BLOCKED';
    /** The ban worked but the unban did not: the person may still be on the group's ban list. */
    bannedNotUnbanned?: boolean;
  }): Promise<MemberLeftResult> {
    let result: MemberLeftResult = { kind: 'NOT_A_MEMBER' };
    await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockById(tx, input.organizationId))) return;
      const before = await this.repository.findById(input.organizationId, tx);
      const member = before?.members.find((m) => m.userId === input.userId);
      if (!member || member.status === 'LEFT') return;
      const now = this.clock.now();
      await this.repository.markMemberLeft(tx, input.organizationId, input.userId, now);
      await this.audit.recordSystem(tx, {
        systemSource: 'TELEGRAM',
        entityType: ENTITY_TYPE,
        entityId: input.organizationId,
        action: input.bannedNotUnbanned
          ? 'TELEGRAM_MEMBER_BANNED_NOT_UNBANNED'
          : 'TELEGRAM_MEMBER_REMOVED_FROM_CHAT',
        changes: {
          [`members.${input.userId}.status`]: { from: 'ACTIVE', to: 'LEFT' },
          ...(input.bannedNotUnbanned
            ? { memberBannedButNotUnbanned: { from: false, to: true } }
            : {}),
          removalReason: { from: null, to: input.reason },
          removalRequestedByUserId: { from: null, to: input.requestedByUserId },
          removalRequestedAt: { from: null, to: input.requestedAt },
        },
      });
      result = { kind: 'LEFT' };
    });
    return result;
  }

  private async registerGroupOnce(
    input: TelegramGroupEvent & { addedBy: TelegramAddedBy | null },
    name: string,
  ): Promise<GroupStatusResult> {
    if (!(await this.repository.findByChatId(input.chatId))) {
      const created = await this.repository.transaction(async (tx) => {
        const now = this.clock.now();
        const addedBy = input.addedBy
          ? {
              telegramUserId: input.addedBy.telegramUserId,
              name: normalizePersonName(input.addedBy.name, input.addedBy.telegramUserId),
            }
          : null;
        const organizationId = await this.repository.createFromTelegram(tx, {
          name,
          chatId: input.chatId,
          now,
          eventAt: input.eventAt,
          addedBy,
        });
        const after = await this.repository.findById(organizationId, tx);
        if (!after) throw new NotFoundError('Organization not found');
        await this.audit.recordSystem(tx, {
          systemSource: 'TELEGRAM',
          entityType: ENTITY_TYPE,
          entityId: organizationId,
          action: 'TELEGRAM_ORGANIZATION_CREATED',
          changes: diffFields({}, snapshot(after)),
        });
        // Beyond the cap the group is registered and listed as pending, but staff are not
        // messaged: adding the bot to groups costs nothing, the notices would cost every manager.
        if (this.pendingNotices.allow(addedBy?.telegramUserId ?? null, now.getTime())) {
          await enqueueStaffNotice(
            tx,
            {
              type: 'ORGANIZATION_PENDING',
              dedupeKey: `organization-pending:${organizationId}`,
              payload: {
                organizationName: name,
                chatId: input.chatId.toString(),
                ...(addedBy
                  ? {
                      addedByName: addedBy.name,
                      addedByTelegramUserId: addedBy.telegramUserId.toString(),
                    }
                  : {}),
              },
            },
            now,
          );
        }
        return organizationId;
      });
      return { organizationId: created, outcome: 'CREATED' };
    }
    return this.noteBotAddedToKnownGroup(input);
  }

  /**
   * The bot was added to a group that already is an organization. Status, name and members stay
   * as they are; the event is audited (once per event time) and moves the ordering guard forward,
   * so a late, older "bot removed" cannot deactivate an organization staff activated since.
   */
  private async noteBotAddedToKnownGroup(
    input: TelegramGroupEvent & { addedBy: TelegramAddedBy | null },
  ): Promise<GroupStatusResult> {
    const known = await this.repository.findByChatId(input.chatId);
    if (!known) return { organizationId: null, outcome: 'UNKNOWN_GROUP' };
    const id = known.organization.id;
    const outcome = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.lockById(tx, id))) {
        throw new NotFoundError('Organization not found');
      }
      const last = await this.repository.findTelegramStatusEventAt(tx, id);
      if (last && input.eventAt.getTime() < last.getTime()) return 'STALE' as const;
      // The same event twice (retry, concurrent copy) writes nothing the second time.
      if (last && input.eventAt.getTime() === last.getTime()) return 'UNCHANGED' as const;
      await this.repository.setTelegramStatusEventAt(tx, id, input.eventAt);
      await this.audit.recordSystem(tx, {
        systemSource: 'TELEGRAM',
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'TELEGRAM_BOT_ADDED_AGAIN',
        changes: {
          botAddedByTelegramUserId: {
            from: null,
            to: input.addedBy ? input.addedBy.telegramUserId.toString() : null,
          },
        },
      });
      return 'UNCHANGED' as const;
    });
    return { organizationId: id, outcome };
  }

  private async deactivateKnownGroup(input: TelegramGroupEvent): Promise<GroupStatusResult> {
    const known = await this.repository.findByChatId(input.chatId);
    if (!known) return { organizationId: null, outcome: 'UNKNOWN_GROUP' };
    const id = known.organization.id;
    let outcome: GroupStatusResult['outcome'] = 'UNCHANGED';
    await this.mutateAsTelegram(id, 'TELEGRAM_ORGANIZATION_DEACTIVATED', async (tx, before) => {
      const last = await this.repository.findTelegramStatusEventAt(tx, id);
      if (last && input.eventAt.getTime() < last.getTime()) {
        outcome = 'STALE';
        return false;
      }
      const seen = last && last.getTime() > input.eventAt.getTime() ? last : input.eventAt;
      if (before.organization.status === 'INACTIVE') {
        await this.repository.setTelegramStatusEventAt(tx, id, seen);
        return false;
      }
      await this.repository.updateFields(tx, id, {
        status: 'INACTIVE',
        updatedAt: this.clock.now(),
        telegramStatusEventAt: seen,
      });
      outcome = 'DEACTIVATED';
      return true;
    });
    return { organizationId: id, outcome };
  }

  // ----------------------------------------------------------------- helpers

  /** Like `mutate`, for a change made by the Telegram bot: audited as the system source TELEGRAM. */
  private async mutateAsTelegram(
    id: string,
    action: `TELEGRAM_${string}`,
    change: (tx: Tx, before: OrganizationWithMembers) => Promise<boolean>,
  ): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lockById(tx, id))) {
          throw new NotFoundError('Organization not found');
        }
        const before = await this.repository.findById(id, tx);
        if (!before) throw new NotFoundError('Organization not found');
        if ((await change(tx, before)) === false) return;

        const after = await this.repository.findById(id, tx);
        if (!after) throw new NotFoundError('Organization not found');
        const changes = diffFields(snapshot(before), snapshot(after));
        if (Object.keys(changes).length === 0) return;
        await this.audit.recordSystem(tx, {
          systemSource: 'TELEGRAM',
          entityType: ENTITY_TYPE,
          entityId: id,
          action,
          changes,
        });
      });
    } catch (error) {
      throw mapMembershipGuardError(error);
    }
  }

  /**
   * One audited organization mutation: lock the row, run `change` (returns false for a no-op),
   * and write the before/after diff in the same transaction. No change, no audit row.
   */
  private async mutate(
    actor: Actor,
    id: string,
    action: string,
    change: (tx: Tx, before: OrganizationWithMembers) => Promise<boolean>,
  ): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lockById(tx, id))) {
          throw new NotFoundError('Organization not found');
        }
        const before = await this.repository.findById(id, tx);
        if (!before) throw new NotFoundError('Organization not found');
        // Every staff write goes through here: an archived organization is read-only until an
        // admin restores it [C, owner 2026-11-13].
        assertNotArchived(before);

        if ((await change(tx, before)) === false) return;

        const after = await this.repository.findById(id, tx);
        if (!after) throw new NotFoundError('Organization not found');
        const changes = diffFields(snapshot(before), snapshot(after));
        if (Object.keys(changes).length === 0) return;
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: ENTITY_TYPE,
          entityId: id,
          action,
          changes,
        });
      });
    } catch (error) {
      throw mapMembershipGuardError(error);
    }
  }

  /** The row lock every organization write takes first, then the locked row. */
  private async lockAndRead(tx: Tx, id: string): Promise<OrganizationWithMembers> {
    if (!(await this.repository.lockById(tx, id)))
      throw new NotFoundError('Organization not found');
    const row = await this.repository.findById(id, tx);
    if (!row) throw new NotFoundError('Organization not found');
    return row;
  }

  private assertMayArchive(actor: Actor): void {
    if (!can(actor, 'ARCHIVE_ORGANIZATION')) throw new ForbiddenError('Access denied');
  }

  private requireActiveMember(org: OrganizationWithMembers, userId: string): MemberView {
    const member = org.members.find((m) => m.userId === userId && m.status === 'ACTIVE');
    if (!member) throw new NotFoundError('Member not found');
    return member;
  }

  private assertMayEdit(actor: Actor): void {
    if (!can(actor, 'EDIT_CUSTOMERS')) throw new ForbiddenError('Access denied');
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_CUSTOMERS')) throw new ForbiddenError('Access denied');
  }

  private async requireDetail(id: string): Promise<OrganizationDetail> {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundError('Organization not found');
    const [detail] = await this.withNames([row]);
    if (!detail) throw new NotFoundError('Organization not found');
    return detail;
  }

  private async withNames(rows: readonly OrganizationWithMembers[]): Promise<OrganizationDetail[]> {
    const ids = [...new Set(rows.flatMap((row) => row.members.map((m) => m.userId)))];
    const people: Map<string, UserSummary> = await this.identity.findSummaries(ids);
    const now = this.clock.now();
    return rows.map((row) => {
      const members = row.members.map((m) => ({
        ...m,
        // A member row always has a user (foreign key); the fallback only keeps the type honest.
        fullName: people.get(m.userId)?.fullName ?? '',
        phone: people.get(m.userId)?.phone ?? null,
      }));
      return {
        organization: row.organization,
        members,
        invite: inviteStatusOf(row.organization, now),
        boundPerson: boundPersonOf(row.organization, members),
      };
    });
  }
}

/**
 * A PERSON has exactly its bound person as shop owner: staff do not assign, remove or change roles
 * there [review 2026-11-12] (a person who leaves makes it INACTIVE, see markMemberLeft).
 */
function assertNotPerson(org: OrganizationWithMembers): void {
  if (org.organization.type === 'PERSON') {
    throw new ConflictError(
      'A person organization keeps its bound person as the only shop owner',
      'PERSON_ORGANIZATION',
    );
  }
}

function assertNotArchived(org: OrganizationWithMembers): void {
  if (org.organization.archivedAt !== null) {
    throw new ConflictError(
      'The organization is archived; an administrator must restore it first',
      'ORGANIZATION_ARCHIVED',
    );
  }
}

/** A bound PERSON's shop owner; the chat id is their Telegram user id (a private chat). */
function boundPersonOf(
  organization: OrganizationView,
  members: readonly MemberDetail[],
): OrganizationDetail['boundPerson'] {
  if (organization.type !== 'PERSON' || organization.telegramChatId === null) return null;
  const owner = members.find((m) => m.status === 'ACTIVE' && m.role === 'SHOP_OWNER');
  return owner
    ? {
        userId: owner.userId,
        fullName: owner.fullName,
        telegramUserId: organization.telegramChatId,
      }
    : null;
}
