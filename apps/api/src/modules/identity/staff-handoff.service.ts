import { Inject, Injectable } from '@nestjs/common';
import { HANDOFF_CODE_PATTERN, HANDOFF_FRAGMENT_PARAM } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { mayUseCustomerApp } from '../../common/auth/staff-viewer.js';
import { Clock } from '../../common/clock/clock.js';
import type { DbClient } from '../../common/database/db-client.js';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from '../../common/errors/domain-errors.js';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AuditService } from '../audit/index.js';
import { IdentityRepository } from './identity.repository.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';
import type { SessionMethod, SessionRecord } from './staff-auth.repository.js';
import {
  HANDOFF_CODE_TTL_SECONDS,
  HANDOFF_ISSUE_LIMIT_PER_ACTOR,
  HANDOFF_ISSUE_WINDOW_SECONDS,
} from './staff-auth.settings.js';
import { StaffHandoffRepository } from './staff-handoff.repository.js';
import { StaffSessionService } from './staff-session.service.js';

const HANDOFF_ENTITY = 'STAFF_HANDOFF';
/** The page of the staff app that asks for a code and sends the browser on (apps/staff router). */
const STAFF_HANDOFF_PAGE_PATH = '/handoff';
/**
 * A used or expired code is removed this long afterwards, when its owner asks for the next one
 * (there is no cleanup job to put it in). The database trigger refuses an earlier deletion.
 */
const STALE_CODE_AFTER_SECONDS = 24 * 60 * 60;

export interface IssuedHandoff {
  /** The customer site with the code in the fragment. Built from configuration only. */
  url: string;
  expiresAt: Date;
}

/** What using a code up gave. Every outcome but `OK` is answered with the same refusal. */
export type HandoffClaim =
  /** Malformed, never issued, or already used. Nobody to attribute it to. */
  | { kind: 'UNKNOWN' }
  /** A real code that came too late, or whose dashboard session ended meanwhile. */
  | { kind: 'REFUSED'; userId: string; reason: 'EXPIRED_CODE' | 'SOURCE_SESSION_ENDED' }
  | { kind: 'OK'; id: string; userId: string; sessionId: string; method: SessionMethod };

/** A configured http(s) address without its trailing slashes, or null. */
function baseUrl(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return value.replace(/\/+$/, '');
}

function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Per-person cap on asking for codes, so a stolen dashboard session cannot fill the table at
 * machine speed. Process local like the sign-in throttle; answers the usual 429 with Retry-After.
 */
@Injectable()
export class HandoffIssueThrottle {
  private readonly limiter = new FixedWindowRateLimiter(
    HANDOFF_ISSUE_LIMIT_PER_ACTOR,
    HANDOFF_ISSUE_WINDOW_SECONDS * 1000,
  );

  check(actorUserId: string, nowMs: number): void {
    const decision = this.limiter.hit(actorUserId, nowMs);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }
}

/**
 * Staff continue on the customer site with their dashboard sign-in ([C] 2026-11-09). The two
 * sites are different origins, so the dashboard asks for a one-time code here and the customer
 * site exchanges it (StaffAuthService.signInWithHandoff) for a VIEWER session.
 *
 * Both addresses come from the api's own configuration (WEB_APP_URL, STAFF_WEB_APP_URL) and never
 * from a request, so neither end can be made to send a browser anywhere else (no open redirect),
 * and the web apps need no build variable to find each other.
 */
@Injectable()
export class StaffHandoffService {
  private readonly customerSiteUrl: string | null;
  private readonly handoffPage: string | null;

  constructor(
    private readonly codes: StaffHandoffRepository,
    private readonly users: IdentityRepository,
    private readonly sessions: StaffSessionService,
    private readonly audit: AuditService,
    private readonly throttle: HandoffIssueThrottle,
    private readonly clock: Clock,
    @Inject(APP_ENV) env: Pick<Env, 'WEB_APP_URL' | 'STAFF_WEB_APP_URL'>,
  ) {
    this.customerSiteUrl = baseUrl(env.WEB_APP_URL);
    const staffSiteUrl = baseUrl(env.STAFF_WEB_APP_URL);
    // Without a staff site of its own (both apps on one origin, or nothing configured) there is
    // no other site to send a visitor to.
    this.handoffPage =
      staffSiteUrl !== null && originOf(staffSiteUrl) !== originOf(this.customerSiteUrl)
        ? `${staffSiteUrl}${STAFF_HANDOFF_PAGE_PATH}`
        : null;
  }

  /**
   * The customer site this caller can be handed over to, or null: the site is not configured, or
   * the request has no website session (Mini App init data, an API token). Inside Telegram the
   * customer Mini App signs the person in by itself, so nothing is lost there.
   */
  customerSiteFor(actor: Actor): string | null {
    assertMayOpenCustomerSite(actor);
    return actor.sessionId === undefined ? null : this.customerSiteUrl;
  }

  /**
   * The page of the staff site the CUSTOMER site sends a returning company employee to, or null.
   * Public knowledge (an address); it names no person.
   */
  handoffPageUrl(): string | null {
    return this.handoffPage;
  }

  /**
   * A new one-time code for the signed-in staff member, bound to the dashboard session of this
   * request. The person is re-read under the row lock, so a block or a role removal that just
   * committed cannot be outrun (those changes lock the same row). Audited without the code.
   */
  async issue(actor: Actor): Promise<IssuedHandoff> {
    assertMayOpenCustomerSite(actor);
    const sessionId = actor.sessionId;
    if (sessionId === undefined) throw new ForbiddenError('Access denied');
    const site = this.customerSiteUrl;
    if (site === null) throw new NotFoundError('The customer site is not configured');
    const now = this.clock.now();
    this.throttle.check(actor.userId, now.getTime());

    const code = generateSessionToken();
    const expiresAt = new Date(now.getTime() + HANDOFF_CODE_TTL_SECONDS * 1000);
    await this.users.transaction(async (tx) => {
      await this.users.lockById(tx, actor.userId);
      const user = await this.users.findById(actor.userId, tx);
      if (
        user?.status !== 'ACTIVE' ||
        !mayUseCustomerApp(user.staffRoles) ||
        // Never from a viewer session: the handoff goes from a staff session to a viewer session
        // and cannot be turned around or chained.
        (await this.liveSourceSession(sessionId, user.id, tx)) === null
      ) {
        throw new ForbiddenError('Access denied');
      }
      // The person's own stale codes go when a new one comes; the row lock serializes it.
      await this.codes.deleteStale(
        tx,
        user.id,
        new Date(now.getTime() - STALE_CODE_AFTER_SECONDS * 1000),
      );
      const id = await this.codes.insertCode(tx, {
        userId: user.id,
        sessionId,
        codeHash: hashSessionToken(code),
        createdAt: now,
        expiresAt,
      });
      await this.audit.record(tx, {
        actorUserId: user.id,
        entityType: HANDOFF_ENTITY,
        entityId: id,
        action: 'STAFF_HANDOFF_ISSUED',
        changes: {
          sessionId: { from: null, to: sessionId },
          expiresAt: { from: null, to: expiresAt.toISOString() },
        },
      });
    });
    return { url: `${site}/#${HANDOFF_FRAGMENT_PARAM}=${code}`, expiresAt };
  }

  /**
   * Uses a code up, whatever happens next: a code that reached the server once never works again.
   * `OK` only for an unexpired code whose dashboard session is still alive; whether the person may
   * still be a viewer is decided when the session is opened, under the row lock.
   */
  async claim(code: string): Promise<HandoffClaim> {
    if (!HANDOFF_CODE_PATTERN.test(code)) return { kind: 'UNKNOWN' };
    const now = this.clock.now();
    const row = await this.codes.claimByHash(hashSessionToken(code), now);
    if (row === null) return { kind: 'UNKNOWN' };
    if (row.expiresAt.getTime() <= now.getTime()) {
      return { kind: 'REFUSED', userId: row.userId, reason: 'EXPIRED_CODE' };
    }
    // The code belongs to the session that asked for it: signing out of the dashboard (or any
    // revocation: block, new password, lost roles) ends the code as well.
    const source = await this.liveSourceSession(row.sessionId, row.userId);
    if (source === null) {
      return { kind: 'REFUSED', userId: row.userId, reason: 'SOURCE_SESSION_ENDED' };
    }
    return {
      kind: 'OK',
      id: row.id,
      userId: row.userId,
      sessionId: row.sessionId,
      method: source.method,
    };
  }

  /**
   * Whether the dashboard session behind a code can still hand its person over. Asked a second
   * time inside the transaction that opens the new session (under the person's row lock).
   */
  async sourceSessionIsLive(sessionId: string, userId: string, db: DbClient): Promise<boolean> {
    return (await this.liveSourceSession(sessionId, userId, db)) !== null;
  }

  /** A live STAFF session of that person: a viewer session is never a source. */
  private async liveSourceSession(
    sessionId: string,
    userId: string,
    db?: DbClient,
  ): Promise<SessionRecord | null> {
    const session = await this.sessions.findLive(sessionId, db);
    return session !== null && session.userId === userId && !session.staffViewer ? session : null;
  }
}

function assertMayOpenCustomerSite(actor: Actor): void {
  if (!can(actor, 'OPEN_CUSTOMER_SITE')) throw new ForbiddenError('Access denied');
}
