import { usdRateStringSchema } from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { lockByName } from '../../../common/database/advisory-lock.js';
import type { DbClient, Tx } from '../../../common/database/db-client.js';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { runInTransaction } from '../../../common/database/transaction.js';
import { CorruptSettingError } from '../../../common/errors/domain-errors.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { MANUAL_RATE_TTL_MS, type UsdRateInputs } from './usd-rate-resolve.js';

export const USD_RATE_KEY = 'usd_rate';
/** Operational status of the Central Bank and channel refreshes (not business data, not audited). */
export const USD_RATE_REFRESH_KEY = 'usd_rate_refresh';

export interface UsdRateState extends UsdRateInputs {
  updatedAt: Date;
}

export interface RefreshStatus {
  lastFailedAt: Date | null;
  lastAttemptAt: Date | null;
  /** Tashkent calendar day (YYYY-MM-DD) of the last successful refresh. */
  lastSuccessDay: string | null;
  /** The last channel read that failed or was refused (cleared by a good read). */
  lastChannelFailedAt: Date | null;
}

// Stored JSON is validated on every read: the column is not trusted just because the application
// wrote it (manual SQL, an old version, a bad restore).
const stateSchema = z.strictObject({
  channel: z
    .strictObject({
      rate: usdRateStringSchema,
      rateDate: z.iso.date(),
      postId: z.number().int().positive(),
    })
    .nullable(),
  manual: z
    .strictObject({
      rate: usdRateStringSchema,
      setBy: z.string().min(1),
      setAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .nullable(),
  bank: z.strictObject({ rate: usdRateStringSchema, rateDate: z.iso.date() }).nullable(),
});
// The version before the channel rule (2026-10-31): one value, either the bank's or a manual one.
const singleValueSchema = z
  .strictObject({
    rate: usdRateStringSchema,
    source: z.enum(['CBU', 'MANUAL']),
    rateDate: z.iso.date().nullable(),
    setBy: z.string().min(1).nullable(),
    followsCentralBank: z.boolean(),
  })
  .refine(
    (v) =>
      v.source === 'CBU'
        ? v.rateDate !== null && v.setBy === null
        : v.rateDate === null && v.setBy !== null,
    'source and rateDate/setBy disagree',
  );
// The first version of this setting (before the Central Bank default): always a manual rate.
const firstVersionSchema = z.strictObject({
  rate: usdRateStringSchema,
  updatedBy: z.string().min(1),
});

const statusSchema = z.strictObject({
  lastFailedAt: z.iso.datetime().nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  lastSuccessDay: z.iso.date().nullable(),
  // Absent in a value written before the channel rule.
  lastChannelFailedAt: z.iso.datetime().nullable().optional(),
});

/**
 * An old manual rate never expired, so it gets its 24 hours from when it was last written, and a
 * "follow the bank" that the bank never answered counts as already ended.
 */
function manualFromOldValue(
  rate: string,
  setBy: string,
  updatedAt: Date,
  ended: boolean,
): UsdRateInputs {
  const expiresAt = ended ? updatedAt : new Date(updatedAt.getTime() + MANUAL_RATE_TTL_MS);
  return {
    channel: null,
    manual: { rate: new Prisma.Decimal(rate), setBy, setAt: updatedAt, expiresAt },
    bank: null,
  };
}

function parseStored(value: unknown, updatedAt: Date): UsdRateInputs | null {
  const current = stateSchema.safeParse(value);
  if (current.success) {
    const { channel, manual, bank } = current.data;
    return {
      channel: channel && { ...channel, rate: new Prisma.Decimal(channel.rate) },
      manual: manual && {
        rate: new Prisma.Decimal(manual.rate),
        setBy: manual.setBy,
        setAt: new Date(manual.setAt),
        expiresAt: new Date(manual.expiresAt),
      },
      bank: bank && { rate: new Prisma.Decimal(bank.rate), rateDate: bank.rateDate },
    };
  }
  const single = singleValueSchema.safeParse(value);
  if (single.success) {
    const { rate, rateDate, setBy, followsCentralBank } = single.data;
    return rateDate !== null
      ? { channel: null, manual: null, bank: { rate: new Prisma.Decimal(rate), rateDate } }
      : manualFromOldValue(rate, setBy ?? '', updatedAt, followsCentralBank);
  }
  const first = firstVersionSchema.safeParse(value);
  return first.success
    ? manualFromOldValue(first.data.rate, first.data.updatedBy, updatedAt, false)
    : null;
}

@Injectable()
export class UsdRateRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  lockNamed(tx: Tx, name: string): Promise<void> {
    return lockByName(tx, name);
  }

  /** Null when no rate has ever been set. A corrupt value throws CorruptSettingError. */
  async readState(db?: DbClient): Promise<UsdRateState | null> {
    const row = await (db ?? this.prisma).appSetting.findUnique({ where: { key: USD_RATE_KEY } });
    if (!row) return null;
    const inputs = parseStored(row.value, row.updatedAt);
    if (inputs === null) {
      // Name the setting only: the stored value is never echoed into an error or a log.
      throw new CorruptSettingError(`Stored setting "${USD_RATE_KEY}" is invalid`);
    }
    return { ...inputs, updatedAt: row.updatedAt };
  }

  async writeState(tx: Tx, inputs: UsdRateInputs, updatedAt: Date): Promise<void> {
    const { channel, manual, bank } = inputs;
    const value: z.infer<typeof stateSchema> = {
      channel: channel && { ...channel, rate: channel.rate.toFixed(4) },
      manual: manual && {
        rate: manual.rate.toFixed(4),
        setBy: manual.setBy,
        setAt: manual.setAt.toISOString(),
        expiresAt: manual.expiresAt.toISOString(),
      },
      bank: bank && { rate: bank.rate.toFixed(4), rateDate: bank.rateDate },
    };
    await tx.appSetting.upsert({
      where: { key: USD_RATE_KEY },
      create: { key: USD_RATE_KEY, value, updatedAt },
      update: { value, updatedAt },
    });
  }

  async readStatus(db?: DbClient): Promise<RefreshStatus> {
    const row = await (db ?? this.prisma).appSetting.findUnique({
      where: { key: USD_RATE_REFRESH_KEY },
    });
    if (!row) {
      return {
        lastFailedAt: null,
        lastAttemptAt: null,
        lastSuccessDay: null,
        lastChannelFailedAt: null,
      };
    }
    const parsed = statusSchema.safeParse(row.value);
    if (!parsed.success) {
      throw new CorruptSettingError(`Stored setting "${USD_RATE_REFRESH_KEY}" is invalid`);
    }
    const { lastFailedAt, lastAttemptAt, lastSuccessDay, lastChannelFailedAt } = parsed.data;
    return {
      lastFailedAt: lastFailedAt ? new Date(lastFailedAt) : null,
      lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt) : null,
      lastSuccessDay,
      lastChannelFailedAt: lastChannelFailedAt ? new Date(lastChannelFailedAt) : null,
    };
  }

  async writeStatus(status: RefreshStatus, updatedAt: Date): Promise<void> {
    const value = {
      lastFailedAt: status.lastFailedAt?.toISOString() ?? null,
      lastAttemptAt: status.lastAttemptAt?.toISOString() ?? null,
      lastSuccessDay: status.lastSuccessDay,
      lastChannelFailedAt: status.lastChannelFailedAt?.toISOString() ?? null,
    };
    await this.prisma.appSetting.upsert({
      where: { key: USD_RATE_REFRESH_KEY },
      create: { key: USD_RATE_REFRESH_KEY, value, updatedAt },
      update: { value, updatedAt },
    });
  }
}
