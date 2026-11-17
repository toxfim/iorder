import { Injectable } from '@nestjs/common';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { failureRoundIsOver } from './staff-auth.settings.js';

export type SessionMethod = 'TELEGRAM_WIDGET' | 'PASSWORD';

/** A session row. The token itself is never stored, only its hash (which stays inside this module). */
export interface SessionRecord {
  id: string;
  userId: string;
  method: SessionMethod;
  /**
   * A staff member's session opened at the CUSTOMER door ([C] 2026-11-09): it resolves to the staff
   * viewer and never to a staff actor. Fixed when the row is created.
   */
  staffViewer: boolean;
  /**
   * The dashboard session a handoff code turned into this viewer session (security review,
   * 2026-11-10); the child is live only while its source is. Null for a session a sign-in opened.
   */
  sourceSessionId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Everything the password check needs. The hash must never leave identity's sign-in code. */
/** Which sign-in door a login opens; a login is unique within its scope only [C, 2026-10-28]. */
export type CredentialScope = 'STAFF' | 'CUSTOMER';

export interface CredentialRecord {
  userId: string;
  login: string;
  passwordHash: string;
  passwordChangedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
}

const SESSION_COLUMNS = {
  id: true,
  userId: true,
  method: true,
  staffViewer: true,
  sourceSessionId: true,
  createdAt: true,
  lastSeenAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

function toSession(row: {
  id: string;
  userId: string;
  method: string;
  staffViewer: boolean;
  sourceSessionId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    // The database CHECK allows only these two values.
    method: row.method === 'PASSWORD' ? 'PASSWORD' : 'TELEGRAM_WIDGET',
    staffViewer: row.staffViewer,
    sourceSessionId: row.sourceSessionId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

@Injectable()
export class StaffAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------- sessions

  async insertSession(
    tx: Tx,
    data: {
      userId: string;
      tokenHash: string;
      method: SessionMethod;
      staffViewer: boolean;
      sourceSessionId: string | null;
      userAgent: string | null;
      now: Date;
      expiresAt: Date;
    },
  ): Promise<SessionRecord> {
    const row = await tx.staffSession.create({
      data: {
        userId: data.userId,
        tokenHash: data.tokenHash,
        method: data.method,
        staffViewer: data.staffViewer,
        sourceSessionId: data.sourceSessionId,
        userAgent: data.userAgent,
        createdAt: data.now,
        lastSeenAt: data.now,
        expiresAt: data.expiresAt,
      },
      select: SESSION_COLUMNS,
    });
    return toSession(row);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.prisma.staffSession.findUnique({
      where: { tokenHash },
      select: SESSION_COLUMNS,
    });
    return row ? toSession(row) : null;
  }

  async findSessionById(id: string, db?: DbClient): Promise<SessionRecord | null> {
    const row = await (db ?? this.prisma).staffSession.findUnique({
      where: { id },
      select: SESSION_COLUMNS,
    });
    return row ? toSession(row) : null;
  }

  /** Only moves `last_seen_at` forward on a session that is still not revoked. */
  async touchSession(id: string, now: Date): Promise<void> {
    await this.prisma.staffSession.updateMany({
      where: { id, revokedAt: null, lastSeenAt: { lt: now } },
      data: { lastSeenAt: now },
    });
  }

  /** True when this call revoked the session (false: already revoked or unknown). */
  async revokeSession(tx: Tx, id: string, now: Date): Promise<boolean> {
    const result = await tx.staffSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count === 1;
  }

  /** Revokes every live session that came from `sourceSessionId` by a handoff; returns how many. */
  async revokeHandedOverSessions(tx: Tx, sourceSessionId: string, now: Date): Promise<number> {
    const result = await tx.staffSession.updateMany({
      where: { sourceSessionId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count;
  }

  /** Revokes every live session of a person; returns how many. */
  async revokeAllForUser(tx: Tx, userId: string, now: Date): Promise<number> {
    const result = await tx.staffSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count;
  }

  // ------------------------------------------------------------ credentials

  /** A login is unique within its scope only: the staff door and the customer door are separate. */
  async findCredentialByLogin(
    scope: CredentialScope,
    login: string,
  ): Promise<CredentialRecord | null> {
    return this.prisma.staffCredential.findUnique({ where: { scope_login: { scope, login } } });
  }

  async findCredentialByUserId(userId: string, tx: Tx): Promise<CredentialRecord | null> {
    return tx.staffCredential.findUnique({ where: { userId } });
  }

  /** Login only (never the hash) for a set of people, for the staff account list. */
  async findLoginsByUserIds(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.staffCredential.findMany({
      where: { userId: { in: [...userIds] } },
      select: { userId: true, login: true },
    });
    return new Map(rows.map((row) => [row.userId, row.login]));
  }

  /** The newest session start per person; people who never signed in on the website are absent. */
  async findLastSignInByUserIds(userIds: readonly string[]): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.staffSession.groupBy({
      by: ['userId'],
      where: { userId: { in: [...userIds] } },
      _max: { createdAt: true },
    });
    const result = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.createdAt) result.set(row.userId, row._max.createdAt);
    }
    return result;
  }

  /** Row lock so concurrent failures count one by one and a lock decision is not raced. */
  async lockCredential(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT user_id FROM staff_credentials WHERE user_id = ${userId}::uuid FOR NO KEY UPDATE`;
  }

  async upsertCredential(
    tx: Tx,
    data: {
      userId: string;
      scope: CredentialScope;
      login: string;
      passwordHash: string;
      passwordChangedAt: Date;
    },
  ): Promise<CredentialRecord> {
    const fresh = {
      scope: data.scope,
      login: data.login,
      passwordHash: data.passwordHash,
      passwordChangedAt: data.passwordChangedAt,
      failedAttempts: 0,
      lockedUntil: null,
      lastFailedAt: null,
    };
    return tx.staffCredential.upsert({
      where: { userId: data.userId },
      create: { userId: data.userId, ...fresh },
      update: fresh,
    });
  }

  /** Changes only the login; the password, its date and its failure counter stay as they are. */
  async updateLogin(tx: Tx, userId: string, login: string): Promise<CredentialRecord> {
    return tx.staffCredential.update({ where: { userId }, data: { login } });
  }

  /**
   * Counts one wrong password. The caller holds the row lock (lockCredential), so concurrent
   * failures count one by one. A finished round (quiet period or served lock) restarts at zero.
   */
  async recordFailure(
    tx: Tx,
    userId: string,
    now: Date,
    lockUntil: (failedAttempts: number) => Date | null,
  ): Promise<{ failedAttempts: number; lockedUntil: Date | null }> {
    const row = await tx.staffCredential.findUniqueOrThrow({ where: { userId } });
    const failedAttempts = (failureRoundIsOver(row, now) ? 0 : row.failedAttempts) + 1;
    const lockedUntil = lockUntil(failedAttempts);
    await tx.staffCredential.update({
      where: { userId },
      data: { failedAttempts, lockedUntil, lastFailedAt: now },
    });
    return { failedAttempts, lockedUntil };
  }

  async resetFailures(tx: Tx, userId: string): Promise<void> {
    await tx.staffCredential.updateMany({
      where: { userId, OR: [{ failedAttempts: { gt: 0 } }, { lockedUntil: { not: null } }] },
      data: { failedAttempts: 0, lockedUntil: null, lastFailedAt: null },
    });
  }
}
