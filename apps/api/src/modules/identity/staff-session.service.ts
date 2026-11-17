import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import {
  mayUseCustomerApp,
  staffOrderingOrganizationOf,
  toStaffViewerActor,
} from '../../common/auth/staff-viewer.js';
import { Clock } from '../../common/clock/clock.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { IdentityRepository } from './identity.repository.js';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.js';
import {
  isSessionLive,
  resolveStaffAuthSettings,
  SESSION_TOUCH_INTERVAL_SECONDS,
  sessionExpiry,
  type StaffAuthSettings,
} from './staff-auth.settings.js';
import {
  StaffAuthRepository,
  type SessionMethod,
  type SessionRecord,
} from './staff-auth.repository.js';

export interface CreatedSession {
  /** Shown once to the browser; only its hash is stored. */
  token: string;
  session: SessionRecord;
}

export interface SessionTimes {
  expiresAt: Date;
  idleExpiresAt: Date;
}

/** Creating, checking and ending website sessions. Knows nothing about HOW a person proved who they are. */
@Injectable()
export class StaffSessionService {
  private readonly settings: StaffAuthSettings;
  private readonly staffOrderingOrganizationId: string | null;

  constructor(
    private readonly repository: StaffAuthRepository,
    private readonly identity: IdentityRepository,
    private readonly clock: Clock,
    @Inject(APP_ENV) env: Env,
  ) {
    this.settings = resolveStaffAuthSettings(env);
    this.staffOrderingOrganizationId = staffOrderingOrganizationOf(env);
  }

  /** In the CALLER'S transaction, so the session and its audit row commit together. */
  async create(
    tx: Tx,
    input: {
      userId: string;
      method: SessionMethod;
      userAgent: string | null;
      /** A staff member signing in at the customer door: a viewer session, never a staff one. */
      staffViewer?: boolean;
      /** The dashboard session a handoff code came from: this session ends with it. */
      sourceSessionId?: string;
    },
  ): Promise<CreatedSession> {
    const now = this.clock.now();
    const token = generateSessionToken();
    const session = await this.repository.insertSession(tx, {
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      method: input.method,
      staffViewer: input.staffViewer === true,
      sourceSessionId: input.sourceSessionId ?? null,
      userAgent: input.userAgent,
      now,
      expiresAt: new Date(now.getTime() + this.settings.absoluteSeconds * 1000),
    });
    return { token, session };
  }

  times(session: SessionRecord): SessionTimes {
    return sessionExpiry(session, this.settings.idleSeconds);
  }

  /**
   * The Actor behind a Bearer token, or null for every problem (malformed, unknown, revoked,
   * idle, expired, user blocked, no active role or organization membership). The caller cannot tell the cases
   * apart. Roles are read fresh on every request, so removing one takes effect at once even
   * before the session rows are revoked.
   *
   * A viewer session (a staff member who signed in at the customer door, [C] 2026-11-09) resolves
   * to the staff viewer and to nothing else: no staff roles on any route, and no membership even
   * if the person later became a customer (they sign in again for that).
   */
  async authenticate(token: string): Promise<Actor | null> {
    if (!isWellFormedSessionToken(token)) return null;
    const session = await this.repository.findSessionByTokenHash(hashSessionToken(token));
    if (!session) return null;
    const now = this.clock.now();
    if (!isSessionLive(session, now, this.settings.idleSeconds)) return null;
    // A session a handoff opened lives only while the dashboard session it came from does
    // (security review, 2026-11-10): a lapsed or ended dashboard session takes it along.
    if (
      session.sourceSessionId !== null &&
      !(await this.sourceIsLive(session.sourceSessionId, now))
    ) {
      return null;
    }

    const user = await this.identity.findById(session.userId);
    if (user?.status !== 'ACTIVE') return null;
    if (session.staffViewer) {
      // Fresh roles decide, as everywhere: a person who lost the roles that open the customer
      // app (or every role) has no viewer session any more.
      if (!mayUseCustomerApp(user.staffRoles)) return null;
      await this.touch(session, now);
      return toStaffViewerActor(
        { userId: user.id, staffRoles: user.staffRoles },
        this.staffOrderingOrganizationId,
        { sessionId: session.id },
      );
    }
    const memberships =
      user.staffRoles.length === 0 ? await this.identity.findActiveMemberships([user.id]) : [];
    const membership = memberships[0];
    if (
      user.staffRoles.length === 0 &&
      (memberships.length !== 1 || !membership?.organizationActive)
    )
      return null;

    await this.touch(session, now);
    return {
      userId: user.id,
      staffRoles: user.staffRoles,
      sessionId: session.id,
      ...(membership
        ? { membership: { organizationId: membership.organizationId, role: membership.role } }
        : {}),
    };
  }

  private async sourceIsLive(sourceSessionId: string, now: Date): Promise<boolean> {
    const source = await this.repository.findSessionById(sourceSessionId);
    return source !== null && isSessionLive(source, now, this.settings.idleSeconds);
  }

  private async touch(session: SessionRecord, now: Date): Promise<void> {
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
      await this.repository.touchSession(session.id, now);
    }
  }

  /**
   * Ends one session and every session a handoff opened from it, in the caller's transaction.
   * `ended` is false when the session was already gone; `handedOver` counts the children ended.
   */
  async revoke(tx: Tx, sessionId: string): Promise<{ ended: boolean; handedOver: number }> {
    const now = this.clock.now();
    const ended = await this.repository.revokeSession(tx, sessionId, now);
    const handedOver = await this.repository.revokeHandedOverSessions(tx, sessionId, now);
    return { ended, handedOver };
  }

  /** Ends every live session of a person (password reset, block, last staff role removed). */
  revokeAllForUser(tx: Tx, userId: string): Promise<number> {
    return this.repository.revokeAllForUser(tx, userId, this.clock.now());
  }

  find(sessionId: string): Promise<SessionRecord | null> {
    return this.repository.findSessionById(sessionId);
  }

  /**
   * The session while it can still be used (not revoked, idle or expired), else null. Only the
   * session is judged here; whether its person may still act is the caller's question.
   */
  async findLive(sessionId: string, db?: DbClient): Promise<SessionRecord | null> {
    const session = await this.repository.findSessionById(sessionId, db);
    if (session === null) return null;
    return isSessionLive(session, this.clock.now(), this.settings.idleSeconds) ? session : null;
  }
}
