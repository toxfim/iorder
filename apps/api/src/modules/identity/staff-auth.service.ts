import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  PasswordSignInRequest,
  SetStaffCredentialsRequest,
  TelegramWidgetSignInRequest,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { assertMayTouchStaffTarget } from '../../common/auth/staff-target.js';
import { can } from '../../common/auth/can.js';
import { mayUseCustomerApp } from '../../common/auth/staff-viewer.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import {
  ForbiddenError,
  InputValidationError,
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AuditService, type AuditChanges, type AuditValue } from '../audit/index.js';
import type { TelegramLoginWidgetVerifier } from '../telegram/login-widget-verifier.js';
import { IdentityRepository } from './identity.repository.js';
import { PasswordHasher } from './password-hasher.js';
import { LOGIN_WIDGET_VERIFIER, STAFF_LOGIN_WIDGET_VERIFIER } from './staff-auth.tokens.js';
import { AnonymousFailureAggregator, SignInThrottle, UsedProofs } from './sign-in-guards.js';
import {
  StaffAuthRepository,
  type CredentialRecord,
  type SessionMethod,
} from './staff-auth.repository.js';
import { lockSecondsAfterFailures, resolveStaffAuthSettings } from './staff-auth.settings.js';
import { StaffHandoffService } from './staff-handoff.service.js';
import { StaffSessionService, type SessionTimes } from './staff-session.service.js';
import type { UserView } from './user.view.js';

const SESSION_ENTITY = 'STAFF_SESSION';
const ATTEMPT_ENTITY = 'AUTH_ATTEMPT';
const USER_ENTITY = 'USER';
const MAX_USER_AGENT_LENGTH = 200;
/** Same tolerance the verifier allows for a clock running ahead; keeps a used proof remembered long enough. */
const PROOF_MEMORY_EXTRA_SECONDS = 120;

/** Where a sign-in request came from. The address is used for throttling only and is never stored. */
export interface SignInContext {
  ip: string;
  userAgent: string | undefined;
}

export interface SignInOutcome {
  token: string;
  session: SessionTimes;
  user: UserView;
}

export interface CredentialsView {
  userId: string;
  login: string;
  passwordChangedAt: Date;
}

/**
 * What a sign-in may open. The staff door opens staff sessions only. At the customer door a
 * CUSTOMER login opens a member session and a STAFF login a viewer session ([C] 2026-11-09), never
 * the other way round; a Telegram proof names a person, whose current roles decide (`CUSTOMER_APP`).
 */
type SessionAudience = 'STAFF' | 'CUSTOMER_MEMBER' | 'STAFF_VIEWER' | 'CUSTOMER_APP';

/** How a failed attempt tried to get in: a session method, or a handoff code. */
type AttemptMethod = SessionMethod | 'STAFF_HANDOFF';

type FailureReason =
  | 'UNKNOWN_LOGIN'
  | 'LOCKED'
  | 'BAD_PASSWORD'
  | 'NOT_CONFIGURED'
  | 'REPLAYED'
  | 'UNKNOWN_USER'
  | 'NOT_ELIGIBLE'
  | 'BAD_PROOF'
  | 'BAD_CODE'
  | 'EXPIRED_CODE'
  | 'SOURCE_SESSION_ENDED';

/** One answer for every sign-in failure: the caller learns nothing about which check failed. */
const invalidCredentials = (): UnauthenticatedError =>
  new UnauthenticatedError('Invalid credentials');

function cleanUserAgent(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  // Control characters out, length bounded: it is stored and shown to staff later.
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_USER_AGENT_LENGTH);
  return cleaned === '' ? null : cleaned;
}

@Injectable()
export class StaffAuthService {
  private readonly proofTtlMs: number;

  constructor(
    private readonly users: IdentityRepository,
    private readonly repository: StaffAuthRepository,
    private readonly sessions: StaffSessionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly throttle: SignInThrottle,
    private readonly proofs: UsedProofs,
    private readonly anonymousFailures: AnonymousFailureAggregator,
    private readonly hasher: PasswordHasher,
    @Inject(LOGIN_WIDGET_VERIFIER) private readonly verifier: TelegramLoginWidgetVerifier | null,
    @Inject(APP_ENV) env: Env,
    private readonly handoffs: StaffHandoffService,
    // The staff website's widget may belong to a second bot (one widget domain per bot). Absent in
    // hand-built test services: the staff widget then uses `verifier`, as before.
    @Optional()
    @Inject(STAFF_LOGIN_WIDGET_VERIFIER)
    private readonly staffVerifier?: TelegramLoginWidgetVerifier | null,
  ) {
    const settings = resolveStaffAuthSettings(env);
    this.proofTtlMs = (settings.loginMaxAgeSeconds + PROOF_MEMORY_EXTRA_SECONDS) * 1000;
  }

  // ------------------------------------------------------------ sign-in

  async signInWithPassword(
    input: PasswordSignInRequest,
    context: SignInContext,
    customerOnly = false,
  ): Promise<SignInOutcome> {
    const login = input.login.trim().toLowerCase();
    const nowMs = this.clock.now().getTime();
    this.throttle.assertCapacity(nowMs);
    this.throttle.check(context.ip, `login:${login}`, nowMs);

    const outcome = customerOnly
      ? await this.passwordAtCustomerDoor(login, input.password, context)
      : await this.passwordAtStaffDoor(login, input.password, context);
    this.throttle.release(context.ip, `login:${login}`, this.clock.now().getTime());
    return outcome;
  }

  /** The staff door looks only among staff logins: a customer login never answers here. */
  private async passwordAtStaffDoor(
    login: string,
    password: string,
    context: SignInContext,
  ): Promise<SignInOutcome> {
    const credential = await this.repository.findCredentialByLogin('STAFF', login);
    if (!credential) {
      await this.hasher.verifyAgainstDummy(password);
      await this.recordFailure('PASSWORD', 'UNKNOWN_LOGIN', null);
      throw invalidCredentials();
    }
    const checked = await this.checkPassword(credential, password);
    if (checked === 'LOCKED') await this.recordFailure('PASSWORD', 'LOCKED', credential.userId);
    if (checked === 'WRONG') await this.recordPasswordFailure(credential.userId);
    if (checked !== 'MATCH') throw invalidCredentials();
    return this.openSession(credential.userId, 'PASSWORD', context, 'STAFF');
  }

  /**
   * The customer door accepts a customer login and, since [C] 2026-11-09, a staff login (the staff
   * member then gets a viewer session). A login is unique within its scope only, so the same text
   * may exist in both: the customer login is tried FIRST, the staff login second [P].
   *
   * Both scopes are always looked up, and every failure costs exactly two password checks (a real
   * one per existing login, a dummy one per missing or locked login), so neither the answer nor
   * the work tells an unknown login from a wrong password, or which scope a login lives in.
   *
   * A failed attempt counts against every login that was really checked, as at its own door: one
   * typed password is one guess against each. A successful one counts against nobody: a staff
   * member whose login text a customer also uses must not lock that customer out by signing in.
   */
  private async passwordAtCustomerDoor(
    login: string,
    password: string,
    context: SignInContext,
  ): Promise<SignInOutcome> {
    const [customer, staff] = await Promise.all([
      this.repository.findCredentialByLogin('CUSTOMER', login),
      this.repository.findCredentialByLogin('STAFF', login),
    ]);
    const customerCheck = await this.checkPassword(customer, password);
    if (customer && customerCheck === 'MATCH') {
      return this.openSession(customer.userId, 'PASSWORD', context, 'CUSTOMER_MEMBER');
    }
    const staffCheck = await this.checkPassword(staff, password);
    if (staff && staffCheck === 'MATCH') {
      return this.openSession(staff.userId, 'PASSWORD', context, 'STAFF_VIEWER');
    }
    if (!customer && !staff) await this.recordFailure('PASSWORD', 'UNKNOWN_LOGIN', null);
    for (const [credential, check] of [
      [customer, customerCheck],
      [staff, staffCheck],
    ] as const) {
      if (!credential) continue;
      if (check === 'LOCKED') await this.recordFailure('PASSWORD', 'LOCKED', credential.userId);
      else await this.recordPasswordFailure(credential.userId);
    }
    throw invalidCredentials();
  }

  /**
   * One password check against one login, always at the cost of one hash: a missing login and a
   * locked one do the same work against a dummy hash. A locked login is never really checked (an
   * attacker must not be able to keep a lock running forever by hammering it).
   */
  private async checkPassword(
    credential: CredentialRecord | null,
    password: string,
  ): Promise<'MATCH' | 'WRONG' | 'LOCKED' | 'ABSENT'> {
    if (!credential) {
      await this.hasher.verifyAgainstDummy(password);
      return 'ABSENT';
    }
    if (credential.lockedUntil !== null && credential.lockedUntil > this.clock.now()) {
      await this.hasher.verifyAgainstDummy(password);
      return 'LOCKED';
    }
    return (await this.hasher.verify(password, credential.passwordHash)) ? 'MATCH' : 'WRONG';
  }

  async signInWithTelegramWidget(
    payload: TelegramWidgetSignInRequest,
    context: SignInContext,
    customerOnly = false,
  ): Promise<SignInOutcome> {
    const nowMs = this.clock.now().getTime();
    this.throttle.assertCapacity(nowMs);
    this.throttle.check(context.ip, `telegram:${String(payload.id)}`, nowMs);

    // The customer site's widget is the main bot; the staff site's may be its own login bot.
    // A proof signed by the other bot fails here: each site accepts only its own bot. (The staff
    // verifier is never null while the main one exists: it falls back to the main bot's token.)
    const verifier = customerOnly ? this.verifier : (this.staffVerifier ?? this.verifier);
    // Without a bot token the widget can never be verified, so it stays closed (fail closed).
    if (!verifier) {
      await this.recordFailure('TELEGRAM_WIDGET', 'NOT_CONFIGURED', null);
      throw invalidCredentials();
    }
    const verified = verifier.verify(payload);
    if (!verified.ok) {
      await this.recordFailure('TELEGRAM_WIDGET', 'BAD_PROOF', null, { proof: verified.reason });
      throw invalidCredentials();
    }
    if (!this.proofs.claim(verified.data.hash, nowMs, this.proofTtlMs)) {
      await this.recordFailure('TELEGRAM_WIDGET', 'REPLAYED', null);
      throw invalidCredentials();
    }
    const user = await this.users.findByTelegramId(BigInt(verified.data.telegramUserId));
    if (!user) {
      await this.recordFailure('TELEGRAM_WIDGET', 'UNKNOWN_USER', null);
      throw invalidCredentials();
    }
    // At the customer door the person's current roles decide: a member session for a customer,
    // a viewer session for a staff member ([C] 2026-11-09).
    const outcome = await this.openSession(
      user.id,
      'TELEGRAM_WIDGET',
      context,
      customerOnly ? 'CUSTOMER_APP' : 'STAFF',
    );
    this.throttle.release(context.ip, `telegram:${String(payload.id)}`, this.clock.now().getTime());
    return outcome;
  }

  /**
   * The customer site exchanges a one-time handoff code of the dashboard ([C] 2026-11-09). The
   * outcome is ALWAYS a viewer session, opened by the same code path as a staff sign-in at the
   * customer door: the person is re-read under the row lock, so a blocked person or one without
   * a viewer role gets nothing. Throttled and answered like a sign-in: a used, expired, unknown or
   * malformed code gets the one answer every failed sign-in gets.
   */
  async signInWithHandoff(code: string, context: SignInContext): Promise<SignInOutcome> {
    const nowMs = this.clock.now().getTime();
    this.throttle.assertCapacity(nowMs);
    // One budget per address: a code names nobody, so there is no narrower identifier to count by.
    this.throttle.check(context.ip, 'handoff', nowMs);

    const claim = await this.handoffs.claim(code);
    if (claim.kind === 'UNKNOWN') {
      await this.recordFailure('STAFF_HANDOFF', 'BAD_CODE', null);
      throw invalidCredentials();
    }
    if (claim.kind === 'REFUSED') {
      await this.recordFailure('STAFF_HANDOFF', claim.reason, claim.userId);
      throw invalidCredentials();
    }
    // The new session keeps the method of the dashboard session it comes from (how the person
    // proved who they are); history says it was a handoff.
    const outcome = await this.openSession(claim.userId, claim.method, context, 'STAFF_VIEWER', {
      id: claim.id,
      sessionId: claim.sessionId,
    });
    this.throttle.release(context.ip, 'handoff', this.clock.now().getTime());
    return outcome;
  }

  // ------------------------------------------------------ session upkeep

  /** Ends the session the request was made with. A request without one (Mini App) changes nothing. */
  async signOut(actor: Actor): Promise<void> {
    const sessionId = actor.sessionId;
    if (sessionId === undefined) return;
    await this.users.transaction(async (tx) => {
      // The same row lock a handoff exchange takes before it checks its source session: a
      // sign-out and an exchange of the same person are serialized, so an exchange can never
      // slip a child session in behind the sign-out that should have ended it.
      await this.users.lockById(tx, actor.userId);
      // A dashboard sign-out also ends every viewer session a handoff opened from this one.
      const { ended, handedOver } = await this.sessions.revoke(tx, sessionId);
      if (!ended) return;
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: SESSION_ENTITY,
        entityId: sessionId,
        action: 'STAFF_SESSION_REVOKED',
        changes: {
          reason: { from: null, to: 'LOGOUT' },
          ...(handedOver > 0 ? { handedOverSessionsRevoked: { from: null, to: handedOver } } : {}),
        },
      });
    });
  }

  async currentSession(actor: Actor): Promise<SessionTimes | null> {
    if (actor.sessionId === undefined) return null;
    const session = await this.sessions.find(actor.sessionId);
    return session ? this.sessions.times(session) : null;
  }

  async ownCustomerCredentials(actor: Actor): Promise<{ login: string | null; canEdit: boolean }> {
    // Customers only. A staff member (also as a viewer of the customer app) keeps the one staff
    // login the manager set: no customer login is ever read or created for them.
    if (!can(actor, 'MANAGE_OWN_CUSTOMER_LOGIN')) throw new ForbiddenError('Access denied');
    const credential = await this.users.transaction((tx) =>
      this.repository.findCredentialByUserId(actor.userId, tx),
    );
    const session =
      actor.sessionId === undefined ? null : await this.sessions.find(actor.sessionId);
    return {
      login: credential?.login ?? null,
      canEdit: actor.sessionId === undefined || session?.method === 'TELEGRAM_WIDGET',
    };
  }

  /** Credential creation/reset requires Telegram proof, never a password-authenticated session. */
  async setOwnCustomerCredentials(
    actor: Actor,
    input: { login: string; password: string },
  ): Promise<{ login: string | null }> {
    if (!can(actor, 'MANAGE_OWN_CUSTOMER_LOGIN')) throw new ForbiddenError('Access denied');
    if (actor.sessionId !== undefined) {
      const session = await this.sessions.find(actor.sessionId);
      if (session?.method !== 'TELEGRAM_WIDGET') throw new ForbiddenError('Sign in with Telegram');
    }
    const hash = await this.hasher.hash(input.password);
    try {
      return await this.users.transaction(async (tx) => {
        await this.users.lockById(tx, actor.userId);
        const user = await this.users.findById(actor.userId, tx);
        const memberships = await this.users.findActiveMemberships([actor.userId], tx);
        if (
          user?.status !== 'ACTIVE' ||
          user.staffRoles.length > 0 ||
          memberships.length !== 1 ||
          !memberships[0]?.organizationActive
        ) {
          throw new ForbiddenError('Access denied');
        }
        const previous = await this.repository.findCredentialByUserId(actor.userId, tx);
        const now = this.clock.now();
        await this.repository.upsertCredential(tx, {
          userId: actor.userId,
          scope: 'CUSTOMER',
          login: input.login,
          passwordHash: hash,
          passwordChangedAt: now,
        });
        // Password changes terminate website sessions, including this one if applicable.
        await this.sessions.revokeAllForUser(tx, actor.userId);
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: 'USER',
          entityId: actor.userId,
          action: 'CUSTOMER_CREDENTIALS_SET',
          changes: {
            login: { from: previous?.login ?? null, to: input.login },
            passwordChangedAt: {
              from: previous?.passwordChangedAt.toISOString() ?? null,
              to: now.toISOString(),
            },
          },
        });
        return { login: input.login };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new InputValidationError([{ path: 'login', message: 'This login is already taken' }]);
      throw error;
    }
  }

  // --------------------------------------------------- credentials (staff)

  /**
   * Sets or resets a staff member's login and/or password. A manager may do this for every staff
   * member except an administrator (a manager must not be able to take over an admin account).
   * A new password ends all the person's sessions and clears their lockout. Nothing secret is
   * returned or audited.
   */
  async setCredentials(
    actor: Actor,
    targetUserId: string,
    input: SetStaffCredentialsRequest,
  ): Promise<CredentialsView> {
    if (!can(actor, 'MANAGE_STAFF_CREDENTIALS')) throw new ForbiddenError('Access denied');
    // Slow on purpose and done before the transaction so no row lock is held meanwhile.
    const passwordHash =
      input.password === undefined ? null : await this.hasher.hash(input.password);

    try {
      return await this.users.transaction((tx) =>
        this.applyCredentials(tx, actor, targetUserId, input, passwordHash),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InputValidationError([{ path: 'login', message: 'This login is already taken' }]);
      }
      throw error;
    }
  }

  private async applyCredentials(
    tx: Tx,
    actor: Actor,
    targetUserId: string,
    input: SetStaffCredentialsRequest,
    passwordHash: string | null,
  ): Promise<CredentialsView> {
    if (!(await this.users.lockById(tx, targetUserId))) throw new NotFoundError('User not found');
    const target = await this.users.findById(targetUserId, tx);
    if (!target) throw new NotFoundError('User not found');
    if (target.staffRoles.length === 0) {
      throw new InputValidationError([
        { path: 'id', message: 'Only staff members have website credentials' },
      ]);
    }
    assertMayTouchStaffTarget(actor, target);
    // A blocked person gets no credentials until unblocked; same answer as the refusals above, so
    // the response does not tell a manager which of the reasons applied.
    if (target.status !== 'ACTIVE') throw new ForbiddenError('Access denied');

    const existing = await this.repository.findCredentialByUserId(targetUserId, tx);
    const login = input.login ?? existing?.login;
    if (login === undefined) {
      throw new InputValidationError([{ path: 'login', message: 'A login is required' }]);
    }
    if (passwordHash === null && !existing) {
      throw new InputValidationError([
        { path: 'password', message: 'A password is required the first time' },
      ]);
    }
    if (input.password !== undefined && input.password.toLowerCase() === login) {
      throw new InputValidationError([
        { path: 'password', message: 'The password must differ from the login' },
      ]);
    }

    const now = this.clock.now();
    const changes: AuditChanges = {};
    let record = existing;
    if (passwordHash !== null) {
      record = await this.repository.upsertCredential(tx, {
        userId: targetUserId,
        scope: 'STAFF',
        login,
        passwordHash,
        passwordChangedAt: now,
      });
      changes['passwordChangedAt'] = {
        from: existing ? existing.passwordChangedAt.toISOString() : null,
        to: now.toISOString(),
      };
      const revoked = await this.sessions.revokeAllForUser(tx, targetUserId);
      if (revoked > 0) changes['sessionsRevoked'] = { from: null, to: revoked };
    } else if (existing && existing.login !== login) {
      record = await this.repository.updateLogin(tx, targetUserId, login);
    }
    if (!record) throw new NotFoundError('User not found');
    if ((existing?.login ?? null) !== login) {
      changes['login'] = { from: existing?.login ?? null, to: login };
    }

    if (Object.keys(changes).length > 0) {
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: USER_ENTITY,
        entityId: targetUserId,
        action: 'STAFF_CREDENTIALS_SET',
        changes,
      });
    }
    return {
      userId: targetUserId,
      login: record.login,
      passwordChangedAt: record.passwordChangedAt,
    };
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Creates the session in one transaction with its audit row. The person is re-read under a row
   * lock, so a block or a role removal that committed just before cannot be outrun by this
   * sign-in (those changes lock the same row and revoke sessions).
   */
  private async openSession(
    userId: string,
    method: SessionMethod,
    context: SignInContext,
    audience: SessionAudience,
    /**
     * Set when a handoff code, not a password or a Telegram proof, asks for the session:
     * the code's id and the dashboard session it belongs to.
     */
    handoff?: { id: string; sessionId: string },
  ): Promise<SignInOutcome> {
    const outcome = await this.users.transaction(async (tx) => {
      await this.users.lockById(tx, userId);
      const user = await this.users.findById(userId, tx);
      // Checked again HERE, under the row lock: a new password, a block or a lost role ends the
      // person's sessions under the same lock, so a handoff that passed its own check a moment
      // earlier cannot slip a new session in behind such a change.
      if (handoff && !(await this.handoffs.sourceSessionIsLive(handoff.sessionId, userId, tx))) {
        await this.recordFailureIn(tx, 'STAFF_HANDOFF', 'SOURCE_SESSION_ENDED', userId);
        return null;
      }
      const opened =
        user?.status === 'ACTIVE' ? await this.sessionKindFor(tx, user, audience) : null;
      if (!user || opened === null) {
        // A blocked person, a person who lost every role, a customer at the staff door, a staff
        // member whose roles do not open the customer app: no session. The failure is recorded
        // inside this transaction, which therefore commits.
        await this.recordFailureIn(tx, handoff ? 'STAFF_HANDOFF' : method, 'NOT_ELIGIBLE', userId);
        return null;
      }
      // Only a correct password clears the wrong-password counter; a handoff proves no password.
      if (method === 'PASSWORD' && !handoff) await this.repository.resetFailures(tx, userId);
      const created = await this.sessions.create(tx, {
        userId,
        method,
        userAgent: cleanUserAgent(context.userAgent),
        staffViewer: opened === 'STAFF_VIEWER',
        // The viewer session a handoff opens ends with the dashboard session it came from.
        ...(handoff ? { sourceSessionId: handoff.sessionId } : {}),
      });
      await this.audit.record(tx, {
        actorUserId: userId,
        entityType: SESSION_ENTITY,
        entityId: created.session.id,
        action: opened === 'STAFF' ? 'STAFF_SESSION_CREATED' : 'CUSTOMER_SESSION_CREATED',
        changes: {
          method: { from: null, to: method },
          expiresAt: { from: null, to: created.session.expiresAt.toISOString() },
          // History says in what capacity a staff member entered the customer app.
          ...(opened === 'STAFF_VIEWER' ? { staffViewer: { from: null, to: true } } : {}),
          // ... and that the dashboard handed them over, by which code.
          ...(handoff ? { handoff: { from: null, to: handoff.id } } : {}),
        },
      });
      return { created, user };
    });
    if (!outcome) throw invalidCredentials();
    return {
      token: outcome.created.token,
      session: this.sessions.times(outcome.created.session),
      user: outcome.user,
    };
  }

  /**
   * The session an ACTIVE person may open at this door, read under the row lock, or null. A staff
   * member is never a customer member and a customer never a viewer; the staff door is unchanged.
   */
  private async sessionKindFor(
    tx: Tx,
    user: UserView,
    audience: SessionAudience,
  ): Promise<'STAFF' | 'CUSTOMER_MEMBER' | 'STAFF_VIEWER' | null> {
    const isStaff = user.staffRoles.length > 0;
    if (audience === 'STAFF') return isStaff ? 'STAFF' : null;
    if (isStaff) {
      return audience !== 'CUSTOMER_MEMBER' && mayUseCustomerApp(user.staffRoles)
        ? 'STAFF_VIEWER'
        : null;
    }
    if (audience === 'STAFF_VIEWER') return null;
    const memberships = await this.users.findActiveMemberships([user.id], tx);
    return memberships.length === 1 && memberships[0]?.organizationActive === true
      ? 'CUSTOMER_MEMBER'
      : null;
  }

  /** Counts a wrong password and locks the login after repeated ones (backoff, capped). */
  private async recordPasswordFailure(userId: string): Promise<void> {
    await this.users.transaction(async (tx) => {
      await this.repository.lockCredential(tx, userId);
      const now = this.clock.now();
      const result = await this.repository.recordFailure(tx, userId, now, (failures) => {
        const seconds = lockSecondsAfterFailures(failures);
        return seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
      });
      await this.recordFailureIn(tx, 'PASSWORD', 'BAD_PASSWORD', userId, {
        failedAttempts: result.failedAttempts,
        lockedUntil: result.lockedUntil ? result.lockedUntil.toISOString() : null,
      });
    });
  }

  private recordFailure(
    method: AttemptMethod,
    reason: FailureReason,
    userId: string | null,
    extra: Record<string, AuditValue> = {},
  ): Promise<void> {
    return this.users.transaction((tx) => this.recordFailureIn(tx, method, reason, userId, extra));
  }

  /**
   * A failed sign-in, as the system source AUTH (nobody was authenticated). Holds the method and a
   * reason code, never the typed login, the password, the token or the address.
   */
  private async recordFailureIn(
    tx: Tx,
    method: AttemptMethod,
    reason: FailureReason,
    userId: string | null,
    extra: Record<string, AuditValue> = {},
  ): Promise<void> {
    const nowMs = this.clock.now().getTime();
    this.throttle.noteFailure(nowMs);
    const changes: AuditChanges = {
      method: { from: null, to: method },
      reason: { from: null, to: reason },
    };
    if (userId === null || reason === 'LOCKED') {
      // Nobody to attribute it to, or a login that is already locked: aggregate instead of one
      // append-only row per attempt. Attempts against a lock cost an attacker nothing (no
      // password work counts, no lock is extended), so they must not grow the audit log either.
      const decision = this.anonymousFailures.decide(`${method}:${reason}:${userId ?? ''}`, nowMs);
      if (!decision.write) return;
      changes['count'] = { from: null, to: 1 };
      if (decision.previousBucketAttempts > 0) {
        changes['previousBucketStart'] = { from: null, to: decision.previousBucketStart };
        changes['previousBucketCount'] = { from: null, to: decision.previousBucketAttempts };
      }
    }
    for (const [key, value] of Object.entries(extra)) changes[key] = { from: null, to: value };
    await this.audit.recordSystem(tx, {
      systemSource: 'AUTH',
      entityType: userId === null ? ATTEMPT_ENTITY : USER_ENTITY,
      entityId: userId ?? `${method.toLowerCase()}:unverified`,
      action: 'AUTH_SIGN_IN_FAILED',
      changes,
    });
  }
}
