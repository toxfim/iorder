import { Injectable } from '@nestjs/common';
import type { Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';

/** A token row. The hash never leaves this repository and the service. */
export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

const COLUMNS = {
  id: true,
  userId: true,
  name: true,
  scopes: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
} as const;

@Injectable()
export class ApiTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  async insert(
    tx: Tx,
    data: {
      userId: string;
      name: string;
      tokenHash: string;
      scopes: readonly string[];
      now: Date;
      expiresAt: Date;
    },
  ): Promise<ApiTokenRecord> {
    return tx.apiToken.create({
      data: {
        userId: data.userId,
        name: data.name,
        tokenHash: data.tokenHash,
        scopes: [...data.scopes],
        createdAt: data.now,
        expiresAt: data.expiresAt,
      },
      select: COLUMNS,
    });
  }

  findByTokenHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    return this.prisma.apiToken.findUnique({ where: { tokenHash }, select: COLUMNS });
  }

  findById(tx: Tx, id: string): Promise<ApiTokenRecord | null> {
    return tx.apiToken.findUnique({ where: { id }, select: COLUMNS });
  }

  /** Only moves last_used_at forward on a token that is not revoked. */
  async touch(id: string, now: Date): Promise<void> {
    await this.prisma.apiToken.updateMany({
      where: { id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: now } }] },
      data: { lastUsedAt: now },
    });
  }

  /** True when this call revoked the token (false: already revoked or unknown). */
  async revoke(tx: Tx, id: string, now: Date): Promise<boolean> {
    const result = await tx.apiToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count === 1;
  }
}
