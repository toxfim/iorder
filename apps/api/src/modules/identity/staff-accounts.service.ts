import { Injectable } from '@nestjs/common';
import { STAFF_PASSWORD_MIN_LENGTH } from '@iorder/shared/staff-auth';
import type { CreateStaffAccountRequest, SetStaffTelegramRequest } from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { assertMayTouchStaffTarget } from '../../common/auth/staff-target.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { mapMembershipGuardError } from '../../common/database/staff-membership-guard.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { AuditService, type AuditChanges } from '../audit/index.js';
import { IdentityRepository } from './identity.repository.js';
import { PasswordHasher } from './password-hasher.js';
import { StaffWriteThrottle } from './staff-write-throttle.js';
import { StaffAuthRepository } from './staff-auth.repository.js';
import { StaffSessionService } from './staff-session.service.js';
import type { UserView } from './user.view.js';

const USER_ENTITY = 'USER';
const BOOTSTRAP_ADMIN_NAME = 'Administrator';

/** A staff account as the staff directory shows it. Carries no hash and no Telegram id. */
export interface StaffAccountView {
  user: UserView;
  login: string | null;
  hasPassword: boolean;
  lastSignInAt: Date | null;
}

export interface BootstrapAdminAccountInput {
  login: string;
  password: string;
}

export interface BootstrapAdminAccountResult {
  userCreated: boolean;
  passwordSet: boolean;
}

const loginTaken = (): InputValidationError =>
  new InputValidationError([{ path: 'login', message: 'This login is already taken' }]);
const telegramTaken = (): InputValidationError =>
  new InputValidationError([
    { path: 'telegramUserId', message: 'This Telegram account is linked to another person' },
  ]);

/** The bootstrap may only touch an ACTIVE administrator: it never reactivates or promotes anyone. */
function assertBootstrapAdmin(user: UserView | null): void {
  if (!user?.staffRoles.includes('ADMIN')) {
    throw new InputValidationError([
      { path: 'login', message: 'This login belongs to someone who is not an administrator' },
    ]);
  }
  if (user.status !== 'ACTIVE') {
    throw new ConflictError('The administrator is blocked; unblock them first', 'USER_BLOCKED');
  }
}

/**
 * Staff accounts created by a manager or admin (owner request 2026-10-22), the Telegram link of a
 * staff account, and the bootstrap of the first administrator by login + password. Every change
 * and its audit row commit in one transaction. No secret is ever audited or returned.
 */
@Injectable()
export class StaffAccountsService {
  constructor(
    private readonly users: IdentityRepository,
    private readonly credentials: StaffAuthRepository,
    private readonly sessions: StaffSessionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly hasher: PasswordHasher,
    private readonly throttle: StaffWriteThrottle,
  ) {}

  // ------------------------------------------------------------------ reads

  /** The people only: a reader's list does not even load the logins. */
  async directory(actor: Actor): Promise<UserView[]> {
    if (!can(actor, 'VIEW_STAFF_DIRECTORY')) throw new ForbiddenError('Access denied');
    return this.users.listStaff();
  }

  async list(actor: Actor): Promise<StaffAccountView[]> {
    this.assertAllowed(actor);
    const staff = await this.users.listStaff();
    const ids = staff.map((user) => user.id);
    const [logins, lastSignIns] = await Promise.all([
      this.credentials.findLoginsByUserIds(ids),
      this.credentials.findLastSignInByUserIds(ids),
    ]);
    return staff.map((user) => ({
      user,
      login: logins.get(user.id) ?? null,
      hasPassword: logins.has(user.id),
      lastSignInAt: lastSignIns.get(user.id) ?? null,
    }));
  }

  // ----------------------------------------------------------------- create

  /**
   * One transaction: the person, their roles, their login and password, and the audit row. A
   * manager cannot create an administrator. Customers cannot be created here (a role is required
   * by the contract and again by the database, which refuses a person with neither a Telegram id
   * nor a role). The Telegram id is required by the contract [C, 2026-10-28], so the bot can tell
   * the person apart from customers in a group from day one.
   */
  async create(actor: Actor, input: CreateStaffAccountRequest): Promise<StaffAccountView> {
    this.assertAllowed(actor);
    this.throttle.check(actor.userId, this.clock.now().getTime());
    if (input.roles.includes('ADMIN') && !actor.staffRoles.includes('ADMIN')) {
      throw new ForbiddenError('Access denied');
    }
    if (input.password.toLowerCase() === input.login) {
      throw new InputValidationError([
        { path: 'password', message: 'The password must differ from the login' },
      ]);
    }
    // Slow on purpose and done before the transaction so no lock is held meanwhile.
    const passwordHash = await this.hasher.hash(input.password);
    const telegramUserId = BigInt(input.telegramUserId);

    try {
      return await this.users.transaction((tx) =>
        this.createIn(tx, actor, input, passwordHash, telegramUserId),
      );
    } catch (error) {
      throw await this.translateCreateError(error, input.login, telegramUserId);
    }
  }

  private async createIn(
    tx: Tx,
    actor: Actor,
    input: CreateStaffAccountRequest,
    passwordHash: string,
    telegramUserId: bigint | null,
  ): Promise<StaffAccountView> {
    const now = this.clock.now();
    const created = await this.users.create(tx, {
      telegramUserId,
      fullName: input.fullName,
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(input.language === undefined ? {} : { language: input.language }),
      now,
    });
    for (const role of input.roles) await this.users.addRole(tx, created.id, role);
    const credential = await this.credentials.upsertCredential(tx, {
      userId: created.id,
      scope: 'STAFF',
      login: input.login,
      passwordHash,
      passwordChangedAt: now,
    });
    const roles = [...input.roles].sort();
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: USER_ENTITY,
      entityId: created.id,
      action: 'STAFF_ACCOUNT_CREATED',
      changes: {
        fullName: { from: null, to: created.fullName },
        staffRoles: { from: null, to: roles },
        login: { from: null, to: credential.login },
        passwordChangedAt: { from: null, to: now.toISOString() },
        telegramLinked: { from: null, to: telegramUserId !== null },
      },
    });
    return {
      user: { ...created, staffRoles: roles },
      login: credential.login,
      hasPassword: true,
      lastSignInAt: null,
    };
  }

  /** Tells which uniqueness rule failed, so the manager sees a precise (and harmless) message. */
  private async translateCreateError(
    error: unknown,
    login: string,
    telegramUserId: bigint | null,
  ): Promise<unknown> {
    if (!isUniqueViolation(error)) return mapMembershipGuardError(error);
    if (telegramUserId !== null && (await this.users.findByTelegramId(telegramUserId))) {
      return telegramTaken();
    }
    if (await this.credentials.findCredentialByLogin('STAFF', login)) return loginTaken();
    return error;
  }

  // ------------------------------------------------------- Telegram link

  /**
   * Links the Telegram account of a staff member, or replaces it with another one. Sign-in
   * through Telegram (Mini App or widget) works only while the id matches. Linking a different id
   * ends the person's sessions: a session obtained through the old account must not outlive it.
   * A manager cannot touch an administrator. Removing the id is not possible [C, 2026-10-28]: an
   * unlinked staff member would be taken for a customer in a Telegram group.
   */
  async setTelegram(
    actor: Actor,
    targetUserId: string,
    input: SetStaffTelegramRequest,
  ): Promise<StaffAccountView> {
    this.assertAllowed(actor);
    this.throttle.check(actor.userId, this.clock.now().getTime());
    const next = BigInt(input.telegramUserId);
    try {
      await this.users.transaction((tx) => this.setTelegramIn(tx, actor, targetUserId, next));
    } catch (error) {
      if (isUniqueViolation(error)) throw telegramTaken();
      throw mapMembershipGuardError(error);
    }
    return this.requireAccount(targetUserId);
  }

  private async setTelegramIn(
    tx: Tx,
    actor: Actor,
    targetUserId: string,
    next: bigint,
  ): Promise<void> {
    // A missing id answers like an administrator's id to anyone but an administrator, so a
    // manager cannot probe which ids are administrators.
    const missing = (): Error =>
      actor.staffRoles.includes('ADMIN')
        ? new NotFoundError('User not found')
        : new ForbiddenError('Access denied');
    if (!(await this.users.lockById(tx, targetUserId))) throw missing();
    const before = await this.users.findById(targetUserId, tx);
    if (!before) throw missing();
    assertMayTouchStaffTarget(actor, before);
    if (before.staffRoles.length === 0) {
      throw new InputValidationError([
        { path: 'id', message: 'Only staff members have a staff Telegram link' },
      ]);
    }
    if (before.telegramUserId === next) return;

    await this.users.updateFields(tx, targetUserId, {
      telegramUserId: next,
      updatedAt: this.clock.now(),
    });
    const changes: AuditChanges = {
      telegramUserId: {
        from: before.telegramUserId === null ? null : before.telegramUserId.toString(),
        to: next.toString(),
      },
    };
    const revoked = await this.sessions.revokeAllForUser(tx, targetUserId);
    if (revoked > 0) changes['sessionsRevoked'] = { from: null, to: revoked };
    await this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: USER_ENTITY,
      entityId: targetUserId,
      action: 'STAFF_TELEGRAM_LINKED',
      changes,
    });
  }

  // -------------------------------------------------------------- bootstrap

  /**
   * First administrator by login + password (`staff:bootstrap-admin`). Idempotent: with the same
   * login and password again nothing changes. Audited as the system source BOOTSTRAP, never with
   * the password or its hash. Refuses a login that belongs to someone who is not an administrator
   * and a blocked administrator (never silently reactivated).
   */
  async bootstrapAdminAccount(
    input: BootstrapAdminAccountInput,
  ): Promise<BootstrapAdminAccountResult> {
    if ([...input.password].length < STAFF_PASSWORD_MIN_LENGTH) {
      throw new InputValidationError([
        {
          path: 'password',
          message: `Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters`,
        },
      ]);
    }
    if (input.password.toLowerCase() === input.login) {
      throw new InputValidationError([
        { path: 'password', message: 'The password must differ from the login' },
      ]);
    }
    const existing = await this.credentials.findCredentialByLogin('STAFF', input.login);
    if (existing && (await this.hasher.verify(input.password, existing.passwordHash))) {
      // Same password: still make sure the person really is an active administrator.
      await this.assertBootstrapTarget(existing.userId);
      return { userCreated: false, passwordSet: false };
    }
    const passwordHash = await this.hasher.hash(input.password);
    try {
      return await this.users.transaction((tx) => this.bootstrapIn(tx, input.login, passwordHash));
    } catch (error) {
      // Two runs created the same login at once: the second one finds it and updates it.
      if (isUniqueViolation(error)) {
        return this.users.transaction((tx) => this.bootstrapIn(tx, input.login, passwordHash));
      }
      throw mapMembershipGuardError(error);
    }
  }

  /** True when `login` is not an existing account yet and an ACTIVE administrator already exists. */
  async otherActiveAdminsExist(login: string): Promise<boolean> {
    if (await this.credentials.findCredentialByLogin('STAFF', login)) return false;
    return (await this.users.transaction((tx) => this.users.countActiveAdmins(tx))) > 0;
  }

  private async assertBootstrapTarget(userId: string): Promise<void> {
    assertBootstrapAdmin(await this.users.findById(userId));
  }

  private async bootstrapIn(
    tx: Tx,
    login: string,
    passwordHash: string,
  ): Promise<BootstrapAdminAccountResult> {
    const now = this.clock.now();
    const existing = await this.credentials.findCredentialByLogin('STAFF', login);
    let userId: string;
    let userCreated = false;
    if (existing) {
      userId = existing.userId;
      await this.users.lockById(tx, userId);
      assertBootstrapAdmin(await this.users.findById(userId, tx));
    } else {
      const created = await this.users.create(tx, {
        telegramUserId: null,
        fullName: BOOTSTRAP_ADMIN_NAME,
        now,
      });
      userId = created.id;
      userCreated = true;
      await this.users.addRole(tx, userId, 'ADMIN');
    }
    await this.credentials.upsertCredential(tx, {
      userId,
      scope: 'STAFF',
      login,
      passwordHash,
      passwordChangedAt: now,
    });
    const changes: AuditChanges = {
      login: { from: existing ? login : null, to: login },
      passwordChangedAt: {
        from: existing ? existing.passwordChangedAt.toISOString() : null,
        to: now.toISOString(),
      },
    };
    if (userCreated) changes['staffRoles'] = { from: null, to: ['ADMIN'] };
    const revoked = await this.sessions.revokeAllForUser(tx, userId);
    if (revoked > 0) changes['sessionsRevoked'] = { from: null, to: revoked };
    await this.audit.recordSystem(tx, {
      systemSource: 'BOOTSTRAP',
      entityType: USER_ENTITY,
      entityId: userId,
      action: userCreated ? 'BOOTSTRAP_ADMIN_ACCOUNT_CREATED' : 'BOOTSTRAP_ADMIN_PASSWORD_SET',
      changes,
    });
    return { userCreated, passwordSet: true };
  }

  // ---------------------------------------------------------------- helpers

  private assertAllowed(actor: Actor): void {
    if (!can(actor, 'MANAGE_STAFF_ACCOUNTS')) throw new ForbiddenError('Access denied');
  }

  private async requireAccount(userId: string): Promise<StaffAccountView> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    const [logins, lastSignIns] = await Promise.all([
      this.credentials.findLoginsByUserIds([userId]),
      this.credentials.findLastSignInByUserIds([userId]),
    ]);
    return {
      user,
      login: logins.get(userId) ?? null,
      hasPassword: logins.has(userId),
      lastSignInAt: lastSignIns.get(userId) ?? null,
    };
  }
}
