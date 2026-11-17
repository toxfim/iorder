import { Inject, Injectable } from '@nestjs/common';
import {
  uuidSchema,
  type Locale,
  type SetOwnContactRequest,
  type StaffRole,
  type StaffUserListQuery,
  type UpdateUserRequest,
  type UserStatusName,
  type StaffViewerInfo,
} from '@iorder/shared';
import type { UpdateOwnStaffProfileRequest } from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { assertMayTouchStaffTarget } from '../../common/auth/staff-target.js';
import { can } from '../../common/auth/can.js';
import {
  effectiveMembership,
  isStaffViewer,
  type ContextFreeAction,
} from '../../common/auth/permission-matrix.js';
import { staffOrderingOrganizationOf, toStaffViewerActor } from '../../common/auth/staff-viewer.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { mapMembershipGuardError } from '../../common/database/staff-membership-guard.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import {
  cancelPendingKicks,
  enqueueKickMembers,
  readRemovalStatus,
  type KickEnqueueResult,
} from '../../common/outbox/kick-member.js';
import type { GroupRemovalItem } from '@iorder/shared/staff-orders';
import { AuditService, diffFields, type AuditChanges, type AuditValue } from '../audit/index.js';
import { IdentityRepository } from './identity.repository.js';
import { StaffSessionService } from './staff-session.service.js';
import type { ActiveMembershipView, UserSummary, UserView } from './user.view.js';

const ENTITY_TYPE = 'USER';
/** Name given to a bootstrapped admin until the person edits their profile. */
const BOOTSTRAP_ADMIN_NAME = 'Administrator';
/** How many people a name search hands to another module; a search should be narrower. */
const NAME_SEARCH_LIMIT = 500;

/** A user together with their ACTIVE membership (always null for staff). */
export interface UserWithMembership {
  user: UserView;
  membership: ActiveMembershipView | null;
}

export interface BootstrapAdminResult {
  userCreated: boolean;
  roleAdded: boolean;
}

interface UserChange {
  fields: Record<string, unknown>;
  rolesChanged?: boolean;
  /** Audit entries beyond the field diff (for example a requested group removal). */
  extraChanges?: AuditChanges;
  /** Replaces the audit action when only the row's state can tell which one it is. */
  action?: string;
}

/** The two fields a person may change about themselves. Nothing else ever enters this shape. */
interface OwnProfileFields {
  fullName: string;
  phone: string | null;
}

/** What a block queued for the Telegram groups (all zero when the manager did not ask). */
export interface GroupRemovalOutcome extends KickEnqueueResult {
  requested: boolean;
}

export interface RemovalSubject {
  telegramUserId: string | null;
  blocked: boolean;
  isStaff: boolean;
}

export interface BlockResult extends UserWithMembership {
  groupRemoval: GroupRemovalOutcome;
}

/** A person as the bot module sees them: no phone, no timestamps. */
export interface TelegramPerson {
  userId: string;
  telegramUserId: bigint;
  fullName: string;
  language: Locale;
  status: UserStatusName;
  staffRoles: StaffRole[];
  /** The ACTIVE organization membership (always null for staff). */
  membership: ActiveMembershipView | null;
}

export interface EnsureTelegramUserInput {
  telegramUserId: bigint;
  fullName: string;
  language: Locale;
}

export interface EnsuredTelegramPerson {
  person: TelegramPerson;
  created: boolean;
}

/** Where and in which language one person is messaged. In a private chat the chat id is the user id. */
export interface DeliveryTarget {
  userId: string;
  chatId: string;
  language: Locale;
  /** Staff get the staff version of a message (and the staff link); everyone else the customer one. */
  isStaff: boolean;
  /**
   * The person's ACTIVE membership (always null for staff). The sender uses it so a former
   * member, or a member of an inactive organization, gets no order messages (hard rule 6).
   */
  membership: { organizationId: string; organizationActive: boolean } | null;
}

/** How one person is named in a bot message to their organization's group. */
export interface MentionSubject {
  fullName: string;
  /**
   * Decimal string. Null when no Telegram account is linked or the person is not ACTIVE: they
   * are then named in plain text, without a mention.
   */
  telegramUserId: string | null;
}

function toTelegramPerson(
  user: UserView,
  telegramUserId: bigint,
  membership: ActiveMembershipView | null,
): TelegramPerson {
  return {
    userId: user.id,
    telegramUserId,
    fullName: user.fullName,
    language: user.language,
    status: user.status,
    staffRoles: user.staffRoles,
    membership,
  };
}

/** Null when the person has no Telegram account linked yet: there is nowhere to send a message. */
function toDeliveryTarget(
  user: UserView,
  membership: ActiveMembershipView | null,
): DeliveryTarget | null {
  if (user.telegramUserId === null) return null;
  return {
    userId: user.id,
    chatId: user.telegramUserId.toString(),
    language: user.language,
    isStaff: user.staffRoles.length > 0,
    membership: membership
      ? {
          organizationId: membership.organizationId,
          organizationActive: membership.organizationActive,
        }
      : null,
  };
}

function snapshot(user: UserView): Record<string, AuditValue> {
  return {
    fullName: user.fullName,
    phone: user.phone,
    language: user.language,
    status: user.status,
    staffRoles: [...user.staffRoles],
  };
}

function isActiveAdmin(user: UserView): boolean {
  return user.status === 'ACTIVE' && user.staffRoles.includes('ADMIN');
}

@Injectable()
export class IdentityService {
  async getOwnOrganizationName(actor: Actor): Promise<string | undefined> {
    const own = effectiveMembership(actor);
    if (own === undefined) return undefined;
    const [membership] = await this.repository.findActiveMemberships([actor.userId]);
    return membership?.organizationId === own.organizationId
      ? membership.organizationName
      : undefined;
  }

  /**
   * What `/me` tells a staff member about the customer app ([C] 2026-11-09): null for anyone who
   * is not a viewer there (customers, staff whose roles do not open it). `/me` is shared by both
   * apps, so a staff actor (the Mini App sends the same init data in both) is described as the
   * viewer it becomes on the customer routes. Ordering is reported as possible only when the
   * configured organization exists and is ACTIVE right now; nothing else is ever substituted.
   */
  async getStaffViewerInfo(actor: Actor): Promise<StaffViewerInfo | null> {
    const viewer = isStaffViewer(actor)
      ? actor.staffViewer
      : toStaffViewerActor(actor, this.staffOrderingOrganizationId).staffViewer;
    if (viewer === undefined) return null;
    const organizationName =
      viewer.orderingOrganizationId === null
        ? null
        : await this.repository.findActiveOrganizationName(viewer.orderingOrganizationId);
    return { canOrder: organizationName !== null, organizationName };
  }

  private readonly staffOrderingOrganizationId: string | null;

  constructor(
    private readonly repository: IdentityRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly sessions: StaffSessionService,
    @Inject(APP_ENV) env: Pick<Env, 'STAFF_ORDERING_ORGANIZATION_ID'>,
  ) {
    this.staffOrderingOrganizationId = staffOrderingOrganizationOf(env);
  }

  // ------------------------------------------------------------------ reads

  /** The caller's own profile, loaded by the id of the authenticated actor. */
  async getOwnProfile(actor: Actor): Promise<UserView> {
    if (!can(actor, 'VIEW_OWN_PROFILE')) throw new ForbiddenError('Access denied');
    const user = await this.repository.findById(actor.userId);
    // The actor was built from this row a moment ago; a vanished row is a plain 404.
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  /** For the orders module: has the person entered a phone yet? Not an endpoint. */
  async hasContact(userId: string): Promise<boolean> {
    const user = await this.repository.findById(userId);
    return typeof user?.phone === 'string';
  }

  async listUsers(actor: Actor, query: StaffUserListQuery): Promise<UserWithMembership[]> {
    this.assertCan(actor, 'VIEW_CUSTOMERS');
    const users = await this.repository.list({
      ...query,
      searchTelegramId: can(actor, 'VIEW_TELEGRAM_IDS'),
    });
    // A reader of customers (no EDIT_CUSTOMERS) never gets a staff person's phone or Telegram id.
    const visible = can(actor, 'EDIT_CUSTOMERS')
      ? users
      : users.filter((user) => user.staffRoles.length === 0);
    return this.withMemberships(visible);
  }

  /** Active drivers for the release choice. A narrow read: only id and name reach the caller. */
  async listActiveDrivers(actor: Actor): Promise<UserView[]> {
    this.assertCan(actor, 'LIST_DRIVERS');
    return this.repository.list({ status: 'ACTIVE', role: 'DRIVER' });
  }

  async getUser(actor: Actor, id: string): Promise<UserWithMembership> {
    this.assertCan(actor, 'VIEW_CUSTOMERS');
    const user = await this.requireWithMembership(id);
    if (user.user.staffRoles.length > 0 && !can(actor, 'EDIT_CUSTOMERS')) {
      throw new NotFoundError('User not found');
    }
    return user;
  }

  async getPersonCard(actor: Actor, id: string): Promise<UserWithMembership> {
    this.assertCan(actor, 'VIEW_PERSON_CARD');
    return this.requireWithMembership(id);
  }

  async getPersonCardByTelegram(actor: Actor, telegramUserId: bigint): Promise<UserWithMembership> {
    this.assertCan(actor, 'FIND_PERSON_BY_TELEGRAM');
    const user = await this.repository.findByTelegramId(telegramUserId);
    if (!user) throw new NotFoundError('User not found');
    return this.requireWithMembership(user.id);
  }

  /**
   * For other modules: display names by the actor ids they stored. Not an endpoint: the caller has
   * authorized. Those columns are plain text and may hold a non-uuid value, which has no name.
   */
  async findDisplayNames(ids: readonly string[]): Promise<Map<string, string>> {
    const userIds = [...new Set(ids)].filter((id) => uuidSchema.safeParse(id).success);
    const users = await this.repository.findByIds(userIds);
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /**
   * For other modules (organizations): display facts about people, by id. Not an endpoint, so
   * the caller has already authorized the request; the answer carries no Telegram id.
   */
  async findSummaries(
    ids: readonly string[],
    options: { withPhones?: boolean } = {},
  ): Promise<Map<string, UserSummary>> {
    // The caller says whether its audience may see phone numbers; if not they are never copied out.
    const withPhones = options.withPhones ?? true;
    const users = await this.repository.findByIds(ids);
    return new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          fullName: u.fullName,
          phone: withPhones ? u.phone : null,
          status: u.status,
          staffRoles: u.staffRoles,
        },
      ]),
    );
  }

  /**
   * For other modules (the staff order search): ids of people whose name contains the text,
   * ignoring letter case; at most `NAME_SEARCH_LIMIT`. Not an endpoint: the caller has authorized.
   */
  async findIdsByName(search: string): Promise<string[]> {
    return this.repository.findIdsByName(search, NAME_SEARCH_LIMIT);
  }

  // ----------------------------------------------- for the Telegram bot (no actor)

  /**
   * For the bot module: who is behind this Telegram id? Not an endpoint (the bot is the caller
   * and has verified the update's origin). Staff roles are included so that a staff member in a
   * group is never treated as a customer.
   */
  async findTelegramPerson(telegramUserId: bigint): Promise<TelegramPerson | null> {
    const user = await this.repository.findByTelegramId(telegramUserId);
    if (!user) return null;
    const [membership] = await this.repository.findActiveMemberships([user.id]);
    return toTelegramPerson(user, telegramUserId, membership ?? null);
  }

  /**
   * For the bot module: the language a person chose with the bot's language buttons [C, owner
   * 2026-11-13]. Saved only for a person who already has a row (nobody is created by a button);
   * audited as the person's own act, and only when it changes. The bot verified the update's
   * origin; the Telegram id comes from Telegram, never from the button's data.
   */
  async setLanguageByTelegram(
    telegramUserId: bigint,
    language: Locale,
  ): Promise<'CHANGED' | 'UNCHANGED' | 'NO_USER'> {
    return this.repository.transaction(async (tx) => {
      const found = await this.repository.findByTelegramId(telegramUserId, tx);
      if (!found || !(await this.repository.lockById(tx, found.id))) return 'NO_USER';
      const before = await this.repository.findById(found.id, tx);
      if (!before) return 'NO_USER';
      if (before.language === language) return 'UNCHANGED';
      await this.repository.updateFields(tx, before.id, { language, updatedAt: this.clock.now() });
      await this.audit.record(tx, {
        actorUserId: before.id,
        entityType: ENTITY_TYPE,
        entityId: before.id,
        action: 'USER_LANGUAGE_CHANGED',
        changes: { language: { from: before.language, to: language } },
      });
      return 'CHANGED';
    });
  }

  /**
   * For the bot module: makes sure a `users` row exists for a person seen in a group. An existing
   * person is returned unchanged (their name was maybe edited by staff and must not be
   * overwritten from Telegram). Audited as the system source TELEGRAM. Safe under two updates
   * racing for the same new person.
   */
  async ensureTelegramUser(input: EnsureTelegramUserInput): Promise<EnsuredTelegramPerson> {
    const existing = await this.findTelegramPerson(input.telegramUserId);
    if (existing) return { person: existing, created: false };
    try {
      await this.repository.transaction(async (tx) => {
        const now = this.clock.now();
        const user = await this.repository.create(tx, {
          telegramUserId: input.telegramUserId,
          fullName: input.fullName,
          language: input.language,
          now,
        });
        await this.audit.recordSystem(tx, {
          systemSource: 'TELEGRAM',
          entityType: ENTITY_TYPE,
          entityId: user.id,
          action: 'TELEGRAM_USER_CREATED',
          changes: diffFields({}, snapshot(user)),
        });
      });
    } catch (error) {
      // The other update won the race: its row is the one to use.
      if (!isUniqueViolation(error)) throw error;
      const person = await this.findTelegramPerson(input.telegramUserId);
      if (!person) throw error;
      return { person, created: false };
    }
    const person = await this.findTelegramPerson(input.telegramUserId);
    if (!person) throw new NotFoundError('User not found');
    return { person, created: true };
  }

  /**
   * For the notification sender: where to deliver a message to one person. Null when the person
   * is unknown or blocked (a blocked person gets no messages).
   */
  async findDeliveryTarget(userId: string): Promise<DeliveryTarget | null> {
    const user = await this.repository.findById(userId);
    if (user?.status !== 'ACTIVE') return null;
    if (user.staffRoles.length > 0) return toDeliveryTarget(user, null);
    const [membership] = await this.repository.findActiveMemberships([user.id]);
    return toDeliveryTarget(user, membership ?? null);
  }

  /**
   * For the dispatcher before it removes someone from a group: the facts that must still hold at
   * send time. Unlike `findDeliveryTarget` it also answers for a BLOCKED person (that is the
   * point). Null for an unknown user.
   */
  async findRemovalSubject(userId: string): Promise<RemovalSubject | null> {
    const user = await this.repository.findById(userId);
    if (!user) return null;
    return {
      telegramUserId: user.telegramUserId?.toString() ?? null,
      blocked: user.status === 'BLOCKED',
      isStaff: user.staffRoles.length > 0,
    };
  }

  /**
   * For the notification sender: the name of one person and, when they can be mentioned, their
   * Telegram id. Usernames are not stored: a mention by id works with and without one. Null for
   * an unknown user.
   */
  async findMentionSubject(userId: string): Promise<MentionSubject | null> {
    const user = await this.repository.findById(userId);
    if (!user) return null;
    const mentionable = user.status === 'ACTIVE' && user.telegramUserId !== null;
    return {
      fullName: user.fullName,
      telegramUserId: mentionable ? (user.telegramUserId?.toString() ?? null) : null,
    };
  }

  /** For the notification sender: every ACTIVE holder of a staff role. */
  async findDeliveryTargetsByRole(role: StaffRole): Promise<DeliveryTarget[]> {
    const users = await this.repository.list({ role, status: 'ACTIVE' });
    return users.flatMap((user) => toDeliveryTarget(user, null) ?? []);
  }

  // --------------------------------------------------------------- mutations

  async updateUser(
    actor: Actor,
    id: string,
    input: UpdateUserRequest,
  ): Promise<UserWithMembership> {
    this.assertCan(actor, 'EDIT_CUSTOMERS');
    await this.mutate(actor, id, 'USER_UPDATED', () => {
      return {
        fields: {
          ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          ...(input.language === undefined ? {} : { language: input.language }),
        },
      };
    });
    return this.requireWithMembership(id);
  }

  /**
   * A customer's own name and phone: entered at the first order (owner decision 2026-10-23) and
   * changed later from the profile, as often as needed [C, 2026-11-09]. The phone is UNVERIFIED
   * customer input. The same values again change nothing and write no audit row (a retry is safe).
   */
  async setOwnContact(actor: Actor, input: SetOwnContactRequest): Promise<UserView> {
    this.assertCan(actor, 'SET_OWN_CONTACT');
    await this.changeOwnProfile(actor, { fullName: input.fullName, phone: input.phone });
    return this.getOwnProfile(actor);
  }

  /** A staff member's own name and phone, for their profile page. Read by the actor's id only. */
  async getOwnStaffProfile(actor: Actor): Promise<UserView> {
    this.assertCan(actor, 'EDIT_OWN_STAFF_PROFILE');
    return this.getOwnProfile(actor);
  }

  /**
   * A staff member changes their OWN name and phone [C, 2026-11-09]. Unlike `updateUser` this
   * needs no MANAGE_STAFF: the target is always the caller, and only these two fields can change.
   */
  async updateOwnStaffProfile(
    actor: Actor,
    input: UpdateOwnStaffProfileRequest,
  ): Promise<UserView> {
    this.assertCan(actor, 'EDIT_OWN_STAFF_PROFILE');
    await this.changeOwnProfile(actor, { fullName: input.fullName, phone: input.phone });
    return this.getOwnProfile(actor);
  }

  /**
   * The one write behind both own-profile routes. The target is the actor's own id (no id ever
   * comes from a request), and the fields are copied one by one, so a role, a login, a Telegram id
   * or a membership cannot ride along. Order events and sent notifications are not touched: they
   * keep what they recorded.
   */
  private async changeOwnProfile(actor: Actor, input: OwnProfileFields): Promise<void> {
    await this.mutate(
      actor,
      actor.userId,
      'USER_OWN_PROFILE_UPDATED',
      (_tx, before) => {
        // Re-checked under the row lock: a block that committed after the guard read the person
        // must win, as it does for every other request of a blocked person.
        if (before.status !== 'ACTIVE') throw new ForbiddenError('Access denied');
        return {
          fields: { fullName: input.fullName, phone: input.phone },
          // The first phone keeps its own action: it is the "contact entered at the first order"
          // moment the history has always shown.
          ...(before.phone === null && input.phone !== null ? { action: 'USER_CONTACT_SET' } : {}),
        };
      },
      { own: true },
    );
  }

  /**
   * Blocks or unblocks a person. With `removeFromGroups` (block only) one KICK_MEMBER outbox job
   * per ACTIVE membership is written in the SAME transaction as the block and its audit row; the
   * block never depends on Telegram. Unblocking re-adds nobody: the person must be invited again
   * by the group admins ([P], see the work log).
   */
  async setBlocked(
    actor: Actor,
    id: string,
    blocked: boolean,
    options: { removeFromGroups?: boolean } = {},
  ): Promise<BlockResult> {
    this.assertCan(actor, 'EDIT_CUSTOMERS');
    const status: UserStatusName = blocked ? 'BLOCKED' : 'ACTIVE';
    const removeFromGroups = blocked && options.removeFromGroups === true;
    let outcome: KickEnqueueResult = { queued: 0, alreadyRequested: 0 };
    await this.mutate(
      actor,
      id,
      blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED',
      async (tx, before): Promise<UserChange> => {
        if (blocked && isActiveAdmin(before)) await this.assertNotLastAdmin(tx);
        // A blocked person's website sessions end with the block, in the same transaction.
        if (blocked) await this.endSessions(tx, actor, id);
        if (!blocked) {
          const cancelled = await cancelPendingKicks(tx, id);
          if (cancelled > 0) {
            return {
              fields: { status },
              extraChanges: { groupRemovalsCancelled: { from: null, to: cancelled } },
            };
          }
        }
        if (!removeFromGroups) return { fields: { status } };
        outcome = await this.queueGroupRemoval(tx, actor, before);
        return {
          fields: { status },
          extraChanges: {
            groupRemovalRequested: { from: false, to: true },
            groupRemovalQueued: { from: null, to: outcome.queued },
            ...(outcome.alreadyRequested > 0
              ? { groupRemovalAlreadyRequested: { from: null, to: outcome.alreadyRequested } }
              : {}),
          },
        };
      },
    );
    return {
      ...(await this.requireWithMembership(id)),
      groupRemoval: { requested: removeFromGroups, ...outcome },
    };
  }

  /** Per Telegram group: has the bot removed the person yet (PENDING / DONE / FAILED with a code). */
  async getRemovalStatus(actor: Actor, id: string): Promise<GroupRemovalItem[]> {
    this.assertCan(actor, 'VIEW_CUSTOMERS');
    const user = await this.repository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    assertMayTouchStaffTarget(actor, user);
    // Same rule as a write (see `mutate`): any staff target needs MANAGE_STAFF, so a manager cannot
    // tell an administrator from another staff member by the answer.
    if (user.staffRoles.length > 0) this.assertCan(actor, 'MANAGE_STAFF');
    return readRemovalStatus(this.repository.client, id);
  }

  /**
   * Staff and people without a Telegram id are never removed: staff are not organization members
   * (a defensive check; the database also forbids the combination), and without an id there is
   * nobody to remove.
   */
  private async queueGroupRemoval(
    tx: Tx,
    actor: Actor,
    user: UserView,
  ): Promise<KickEnqueueResult> {
    if (user.telegramUserId === null || user.staffRoles.length > 0) {
      return { queued: 0, alreadyRequested: 0 };
    }
    const targets = await this.repository.findKickTargets(tx, user.id);
    return enqueueKickMembers(
      tx,
      {
        userId: user.id,
        telegramUserId: user.telegramUserId.toString(),
        requestedByUserId: actor.userId,
        targets,
      },
      this.clock.now(),
    );
  }

  /** Idempotent: a role the user already holds changes nothing and writes no audit row. */
  async assignStaffRole(actor: Actor, id: string, role: StaffRole): Promise<UserWithMembership> {
    this.assertCan(actor, 'MANAGE_STAFF');
    await this.mutate(actor, id, 'USER_STAFF_ROLE_ASSIGNED', async (tx, before) => {
      const [membership] = await this.repository.findActiveMemberships([id], tx);
      if (membership) {
        throw new ConflictError(
          'A person with an organization membership cannot hold a staff role',
          'STAFF_HAS_MEMBERSHIP',
        );
      }
      if (before.staffRoles.includes(role)) return { fields: {} };
      await this.repository.addRole(tx, id, role);
      // The first staff role ends every session the person opened before it. Such a session was
      // opened as a customer, at the customer site, and carries no mark of that door: left alive,
      // its token would answer with the new staff roles on every staff route. The person signs in
      // again and gets a session of the right kind.
      if (before.staffRoles.length === 0) await this.endSessions(tx, actor, id);
      return { fields: {}, rolesChanged: true };
    });
    return this.requireWithMembership(id);
  }

  /** Idempotent. No minimum number of roles is enforced, except that one ADMIN must remain. */
  async removeStaffRole(actor: Actor, id: string, role: StaffRole): Promise<UserWithMembership> {
    this.assertCan(actor, 'MANAGE_STAFF');
    await this.mutate(actor, id, 'USER_STAFF_ROLE_REMOVED', async (tx, before) => {
      if (role === 'ADMIN' && isActiveAdmin(before)) await this.assertNotLastAdmin(tx);
      const removed = await this.repository.removeRole(tx, id, role);
      // Website sessions are for staff only: losing the last staff role ends them.
      if (removed && before.staffRoles.every((held) => held === role)) {
        await this.endSessions(tx, actor, id);
      }
      return { fields: {}, rolesChanged: removed };
    });
    return this.requireWithMembership(id);
  }

  /**
   * Bootstrap for the first administrator (`seed:admin`): makes sure an ACTIVE user with this
   * Telegram id exists and holds ADMIN. Idempotent. Audited as the system source BOOTSTRAP, not
   * as a person. Refuses a BLOCKED person (409 USER_BLOCKED, never reactivates) and a person who
   * is an organization member (staff are never members).
   */
  async bootstrapAdmin(telegramUserId: bigint): Promise<BootstrapAdminResult> {
    try {
      return await this.bootstrapAdminOnce(telegramUserId);
    } catch (error) {
      // Two runs created the same user at once: the second one just finds it.
      if (isUniqueViolation(error)) return this.bootstrapAdminOnce(telegramUserId);
      throw error;
    }
  }

  private bootstrapAdminOnce(telegramUserId: bigint): Promise<BootstrapAdminResult> {
    return this.repository.transaction(async (tx) => {
      const now = this.clock.now();
      let user = await this.repository.findByTelegramId(telegramUserId, tx);
      const result: BootstrapAdminResult = {
        userCreated: false,
        roleAdded: false,
      };
      if (!user) {
        user = await this.repository.create(tx, {
          telegramUserId,
          fullName: BOOTSTRAP_ADMIN_NAME,
          now,
        });
        result.userCreated = true;
        await this.audit.recordSystem(tx, {
          systemSource: 'BOOTSTRAP',
          entityType: ENTITY_TYPE,
          entityId: user.id,
          action: 'BOOTSTRAP_USER_CREATED',
          changes: diffFields({}, snapshot(user)),
        });
      }
      await this.repository.lockById(tx, user.id);
      // Re-read under the lock: a block that just committed must win over this bootstrap.
      user = (await this.repository.findById(user.id, tx)) ?? user;
      const before = snapshot(user);

      // Never undo a block silently: someone blocked this person on purpose.
      if (user.status !== 'ACTIVE') {
        throw new ConflictError('The user is blocked; unblock them first', 'USER_BLOCKED');
      }
      if (!user.staffRoles.includes('ADMIN')) {
        const [membership] = await this.repository.findActiveMemberships([user.id], tx);
        if (membership) {
          throw new ConflictError(
            'A person with an organization membership cannot hold a staff role',
            'STAFF_HAS_MEMBERSHIP',
          );
        }
        result.roleAdded = await this.repository.addRole(tx, user.id, 'ADMIN');
      }
      if (result.roleAdded) {
        const after = await this.repository.findById(user.id, tx);
        if (!after) throw new NotFoundError('User not found');
        await this.audit.recordSystem(tx, {
          systemSource: 'BOOTSTRAP',
          entityType: ENTITY_TYPE,
          entityId: user.id,
          action: 'BOOTSTRAP_ADMIN_ENSURED',
          changes: diffFields(before, snapshot(after)),
        });
      }
      return result;
    });
  }

  // ----------------------------------------------------------------- helpers

  /**
   * One audited user mutation: lock the row, run `change`, re-read and write the before/after
   * diff in the same transaction. A change that alters nothing writes no audit row. Changing
   * anyone who holds a staff role needs MANAGE_STAFF: a manager (who may edit customers) must
   * not be able to block or rename an administrator. The one exception is `own`: a person
   * changing their own profile, which is only ever accepted for the actor's own id.
   */
  private async mutate(
    actor: Actor,
    id: string,
    defaultAction: string,
    change: (tx: Tx, before: UserView) => UserChange | Promise<UserChange>,
    options: { own?: boolean } = {},
  ): Promise<void> {
    const own = options.own === true;
    // A programming error, never a request: `own` skips the staff-target rules below.
    if (own && id !== actor.userId) throw new ForbiddenError('Access denied');
    try {
      await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lockById(tx, id))) throw new NotFoundError('User not found');
        const before = await this.repository.findById(id, tx);
        if (!before) throw new NotFoundError('User not found');
        if (!own) {
          // The administrator rule is shared with the credential and Telegram paths; any other
          // staff member additionally needs MANAGE_STAFF (administrators only).
          assertMayTouchStaffTarget(actor, before);
          if (before.staffRoles.length > 0) this.assertCan(actor, 'MANAGE_STAFF');
        }

        const { fields, rolesChanged, extraChanges, action } = await change(tx, before);
        const differs = Object.entries(fields).some(
          ([key, value]) => (before as unknown as Record<string, unknown>)[key] !== value,
        );
        if (differs) {
          await this.repository.updateFields(tx, id, { ...fields, updatedAt: this.clock.now() });
        }
        if (!differs && !rolesChanged && !extraChanges) return;

        const after = await this.repository.findById(id, tx);
        if (!after) throw new NotFoundError('User not found');
        const changes = { ...diffFields(snapshot(before), snapshot(after)), ...extraChanges };
        if (Object.keys(changes).length === 0) return;
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: ENTITY_TYPE,
          entityId: id,
          action: action ?? defaultAction,
          changes,
        });
      });
    } catch (error) {
      throw mapMembershipGuardError(error);
    }
  }

  /**
   * Product decision: the system never ends up without an ACTIVE administrator (nobody could
   * repair that from the UI). Called for a target that is currently one; the advisory lock makes
   * two admins removing each other serialize, so the second sees the first one's effect.
   */
  private async assertNotLastAdmin(tx: Tx): Promise<void> {
    await this.repository.lockAdminSet(tx);
    if ((await this.repository.countActiveAdmins(tx)) <= 1) {
      throw new ConflictError('The last active administrator cannot be removed', 'LAST_ADMIN');
    }
  }

  private async endSessions(tx: Tx, actor: Actor, userId: string): Promise<void> {
    const revoked = await this.sessions.revokeAllForUser(tx, userId);
    if (revoked === 0) return;
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: ENTITY_TYPE,
      entityId: userId,
      action: 'STAFF_SESSIONS_REVOKED',
      changes: { sessionsRevoked: { from: null, to: revoked } },
    });
  }

  private assertCan(actor: Actor, action: ContextFreeAction): void {
    if (!can(actor, action)) throw new ForbiddenError('Access denied');
  }

  private async requireWithMembership(id: string): Promise<UserWithMembership> {
    const user = await this.repository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    const [withMembership] = await this.withMemberships([user]);
    if (!withMembership) throw new NotFoundError('User not found');
    return withMembership;
  }

  private async withMemberships(users: readonly UserView[]): Promise<UserWithMembership[]> {
    const memberships = await this.repository.findActiveMemberships(users.map((u) => u.id));
    const byUser = new Map(memberships.map((m) => [m.userId, m]));
    return users.map((user) => ({ user, membership: byUser.get(user.id) ?? null }));
  }
}
