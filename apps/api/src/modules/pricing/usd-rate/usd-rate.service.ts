import type { UsdRateSource } from '@iorder/shared/staff-cost';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../common/auth/actor.js';
import { can } from '../../../common/auth/can.js';
import { Clock } from '../../../common/clock/clock.js';
import type { DbClient } from '../../../common/database/db-client.js';
import { CorruptSettingError, ForbiddenError } from '../../../common/errors/domain-errors.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, diffFields, type AuditValue } from '../../audit/index.js';
import type { UsdRateView } from '../price-reference.types.js';
import { UsdChannelRateProvider } from './usd-channel-rate-provider.js';
import {
  USD_RATE_KEY,
  UsdRateRepository,
  type RefreshStatus,
  type UsdRateState,
} from './usd-rate.repository.js';
import {
  MANUAL_RATE_TTL_MS,
  manualInForce,
  resolveUsdRate,
  tashkentDay,
  type UsdRateInputs,
} from './usd-rate-resolve.js';
import {
  CHANNEL_MAX_BANK_DIFFERENCE,
  RateProviderError,
  UsdRateProvider,
  USD_RATE_PLAUSIBLE_MAX,
  USD_RATE_PLAUSIBLE_MIN,
  type RateProviderErrorKind,
} from './usd-rate-provider.js';

export { tashkentDay } from './usd-rate-resolve.js';

export type RefreshOutcome =
  | { outcome: 'UPDATED' | 'UNCHANGED' | 'CORRUPT_STORED_RATE' | 'STALE_BANK_DATE' }
  | { outcome: 'FAILED'; failure: RateProviderErrorKind };

export type ChannelRefreshOutcome =
  | { outcome: 'UPDATED' | 'UNCHANGED' | 'NO_POST_TODAY' | 'CORRUPT_STORED_RATE' }
  | { outcome: 'FAILED'; failure: RateProviderErrorKind };

/** The current rate as copied onto a published price list version. */
export interface UsdRateSnapshot {
  rate: Prisma.Decimal;
  source: UsdRateSource;
  rateDate: string | null;
}

const RATE_SCALE = 4;
const NO_INPUTS: UsdRateInputs = { channel: null, manual: null, bank: null };

/** The rate in force and every input behind it: the rate can change without its own value moving. */
function snapshotOf(inputs: UsdRateInputs, now: Date): Record<string, AuditValue> {
  const resolved = resolveUsdRate(inputs, now);
  return {
    rate: resolved ? resolved.rate.toFixed(RATE_SCALE) : null,
    source: resolved?.source ?? null,
    rateDate: resolved?.rateDate ?? null,
    channelRate: inputs.channel ? inputs.channel.rate.toFixed(RATE_SCALE) : null,
    channelRateDate: inputs.channel?.rateDate ?? null,
    channelPostId: inputs.channel?.postId ?? null,
    manualRate: inputs.manual ? inputs.manual.rate.toFixed(RATE_SCALE) : null,
    manualSetBy: inputs.manual?.setBy ?? null,
    manualExpiresAt: inputs.manual?.expiresAt.toISOString() ?? null,
    bankRate: inputs.bank ? inputs.bank.rate.toFixed(RATE_SCALE) : null,
    bankRateDate: inputs.bank?.rateDate ?? null,
  };
}

/**
 * The price-list USD rate [C, owner 2026-10-31]: the channel's post for today, else a manual rate
 * within its 24 hours, else the Central Bank + 40 so'm (the one rule is `resolveUsdRate`).
 *
 * The `usd_rate` setting stores the three inputs, never the result, so the rate in force follows
 * the clock. Every change of an input is audited with before/after; a manual rate's end needs no
 * event because the audited `manualExpiresAt` already says when it ends.
 */
@Injectable()
export class UsdRateService {
  constructor(
    private readonly repository: UsdRateRepository,
    private readonly provider: UsdRateProvider,
    private readonly channelProvider: UsdChannelRateProvider,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---- read ----------------------------------------------------------------------------

  async getUsdRate(actor: Actor): Promise<UsdRateView> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    return this.view(await this.repository.readState(), await this.repository.readStatus());
  }

  /** The current rate for a caller who may see cost reference data (the staff dashboard). */
  async readSnapshotFor(actor: Actor): Promise<UsdRateSnapshot | null> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    return this.readSnapshot();
  }

  /** The current rate for a published version's snapshot (internal: no actor check); null when no rate exists yet. */
  async readSnapshot(db?: DbClient): Promise<UsdRateSnapshot | null> {
    const state = await this.repository.readState(db);
    const resolved = state && resolveUsdRate(state, this.clock.now());
    return resolved
      ? { rate: resolved.rate, source: resolved.source, rateDate: resolved.rateDate }
      : null;
  }

  /** The current rate for a figure that can do without it: null when none is set or it is corrupt. */
  async readRateOrNull(): Promise<Prisma.Decimal | null> {
    try {
      return (await this.readSnapshot())?.rate ?? null;
    } catch (error) {
      if (error instanceof CorruptSettingError) return null;
      throw error;
    }
  }

  // ---- manual --------------------------------------------------------------------------

  /** A manual rate stays 24 hours from this entry; entering it again starts a new 24 hours. */
  async setUsdRate(actor: Actor, rate: Prisma.Decimal): Promise<UsdRateView> {
    if (!can(actor, 'SET_USD_RATE')) throw new ForbiddenError('Access denied');
    await this.repository.transaction(async (tx) => {
      await this.repository.lockNamed(tx, USD_RATE_KEY);
      const before = await this.readTolerant(tx);
      const now = this.clock.now();
      const after: UsdRateInputs = {
        ...before.inputs,
        manual: {
          rate,
          setBy: actor.userId,
          setAt: now,
          expiresAt: new Date(now.getTime() + MANUAL_RATE_TTL_MS),
        },
      };
      await this.repository.writeState(tx, after, now);
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: 'APP_SETTING',
        entityId: USD_RATE_KEY,
        action: 'USD_RATE_CHANGED',
        changes: diffFields(before.snapshot(now), snapshotOf(after, now)),
      });
    });
    return this.view(await this.repository.readState(), await this.repository.readStatus());
  }

  /**
   * Ends a manual rate before its 24 hours, and asks the bank once so the fallback is fresh. If the
   * bank is unreachable the last known value stays and `lastRefreshFailedAt` tells staff.
   */
  async followCentralBank(actor: Actor): Promise<UsdRateView> {
    if (!can(actor, 'SET_USD_RATE')) throw new ForbiddenError('Access denied');
    await this.repository.transaction(async (tx) => {
      await this.repository.lockNamed(tx, USD_RATE_KEY);
      const before = await this.readTolerant(tx);
      const now = this.clock.now();
      if (before.inputs.manual && manualInForce(before.inputs, now)) {
        const after: UsdRateInputs = {
          ...before.inputs,
          manual: { ...before.inputs.manual, expiresAt: now },
        };
        await this.repository.writeState(tx, after, now);
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: 'APP_SETTING',
          entityId: USD_RATE_KEY,
          action: 'USD_RATE_FOLLOW_CENTRAL_BANK',
          changes: diffFields(before.snapshot(now), snapshotOf(after, now)),
        });
      }
    });
    await this.refreshFromCentralBank();
    return this.view(await this.repository.readState(), await this.repository.readStatus());
  }

  // ---- Central Bank refresh (system action) ----------------------------------------------

  /**
   * Stores the bank's rate. Always, also under a manual or a channel rate: the bank is what the rate
   * falls back to the moment those end. A bank failure is a typed RESULT, not an exception: the last
   * known value stays and the failure time is recorded so the job can retry and the UI can warn.
   */
  async refreshFromCentralBank(): Promise<RefreshOutcome> {
    const current = await this.readTolerant();
    // A corrupt stored value is NOT replaced by the bank: a manager looks at it (a manual PUT
    // repairs it). Product decision applied without the owner, see the work log.
    if (current.corrupt) return { outcome: 'CORRUPT_STORED_RATE' };

    const attemptAt = this.clock.now();
    let quote;
    try {
      quote = await this.provider.fetchUsdRate();
    } catch (error) {
      if (!(error instanceof RateProviderError)) throw error;
      await this.recordFailure(attemptAt, this.clock.now());
      return { outcome: 'FAILED', failure: error.kind };
    }
    // Everything below is judged at the moment the answer is processed, not when we asked: a
    // slow bank answer around Tashkent midnight belongs to the new day.
    const processedAt = this.clock.now();

    const rate = new Prisma.Decimal(quote.rate);
    if (!isPlausible(rate)) {
      await this.recordFailure(attemptAt, processedAt);
      return { outcome: 'FAILED', failure: 'IMPLAUSIBLE_RATE' };
    }
    // A quote dated before today is not a refresh: keep the stored value, do not count the day as
    // done, and retry later (the same pacing as a failure).
    if (quote.rateDate < tashkentDay(processedAt)) {
      await this.recordFailure(attemptAt, processedAt);
      return { outcome: 'STALE_BANK_DATE' };
    }

    const outcome = await this.repository.transaction(async (tx): Promise<RefreshOutcome> => {
      await this.repository.lockNamed(tx, USD_RATE_KEY);
      const before = await this.readTolerant(tx);
      if (before.corrupt) return { outcome: 'CORRUPT_STORED_RATE' };
      const { bank } = before.inputs;
      if (bank && bank.rate.equals(rate) && bank.rateDate === quote.rateDate) {
        return { outcome: 'UNCHANGED' };
      }
      const after: UsdRateInputs = {
        ...before.inputs,
        bank: { rate, rateDate: quote.rateDate },
      };
      await this.writeSystemChange(tx, before.snapshot(processedAt), after, processedAt);
      return { outcome: 'UPDATED' };
    });

    if (outcome.outcome === 'UPDATED' || outcome.outcome === 'UNCHANGED') {
      const status = await this.repository.readStatus();
      await this.repository.writeStatus(
        {
          ...status,
          lastFailedAt: null,
          lastAttemptAt: attemptAt,
          lastSuccessDay: tashkentDay(processedAt),
        },
        processedAt,
      );
    }
    return outcome;
  }

  // ---- channel refresh (system action) ---------------------------------------------------

  /**
   * Stores today's rate from the channel: the latest post that names today, so a corrected post
   * wins. No post today is a normal day, not a failure. Same typed results as the bank refresh.
   */
  async refreshFromChannel(): Promise<ChannelRefreshOutcome> {
    const current = await this.readTolerant();
    if (current.corrupt) return { outcome: 'CORRUPT_STORED_RATE' };

    let quotes;
    try {
      quotes = await this.channelProvider.fetchRecentQuotes();
    } catch (error) {
      if (!(error instanceof RateProviderError)) throw error;
      return this.channelFailed(error.kind);
    }
    const processedAt = this.clock.now();
    const today = tashkentDay(processedAt);
    const quote = quotes
      .filter((q) => q.rateDate === today)
      .reduce<(typeof quotes)[number] | null>(
        (latest, q) => (latest === null || q.postId > latest.postId ? q : latest),
        null,
      );
    if (quote === null) {
      await this.recordChannelStatus(null, processedAt);
      return { outcome: 'NO_POST_TODAY' };
    }

    const rate = new Prisma.Decimal(quote.rate);
    if (!isPlausible(rate)) return this.channelFailed('IMPLAUSIBLE_RATE');

    const outcome = await this.repository.transaction(
      async (tx): Promise<ChannelRefreshOutcome> => {
        await this.repository.lockNamed(tx, USD_RATE_KEY);
        const before = await this.readTolerant(tx);
        if (before.corrupt) return { outcome: 'CORRUPT_STORED_RATE' };
        const { bank, channel } = before.inputs;
        if (bank && isFarFromBank(rate, bank.rate)) {
          return { outcome: 'FAILED', failure: 'FAR_FROM_BANK' };
        }
        if (channel && channel.rate.equals(rate) && channel.rateDate === quote.rateDate) {
          return { outcome: 'UNCHANGED' };
        }
        const after: UsdRateInputs = {
          ...before.inputs,
          channel: { rate, rateDate: quote.rateDate, postId: quote.postId },
        };
        await this.writeSystemChange(tx, before.snapshot(processedAt), after, processedAt);
        return { outcome: 'UPDATED' };
      },
    );
    if (outcome.outcome === 'FAILED') return this.channelFailed(outcome.failure);
    if (outcome.outcome !== 'CORRUPT_STORED_RATE') {
      await this.recordChannelStatus(null, processedAt);
    }
    return outcome;
  }

  // ---- helpers ---------------------------------------------------------------------------

  private async writeSystemChange(
    tx: Parameters<UsdRateRepository['writeState']>[0],
    before: Record<string, AuditValue>,
    after: UsdRateInputs,
    now: Date,
  ): Promise<void> {
    await this.repository.writeState(tx, after, now);
    await this.audit.recordSystem(tx, {
      systemSource: 'RATE_REFRESH',
      entityType: 'APP_SETTING',
      entityId: USD_RATE_KEY,
      action: 'RATE_REFRESH_UPDATED',
      changes: diffFields(before, snapshotOf(after, now)),
    });
  }

  /** A failed attempt: the old value stays, the time is recorded so staff can be warned. */
  private async recordFailure(attemptAt: Date, failedAt: Date): Promise<void> {
    const status = await this.repository.readStatus();
    await this.repository.writeStatus(
      { ...status, lastFailedAt: failedAt, lastAttemptAt: attemptAt },
      failedAt,
    );
  }

  private async channelFailed(failure: RateProviderErrorKind): Promise<ChannelRefreshOutcome> {
    const now = this.clock.now();
    await this.recordChannelStatus(now, now);
    return { outcome: 'FAILED', failure };
  }

  private async recordChannelStatus(failedAt: Date | null, now: Date): Promise<void> {
    const status = await this.repository.readStatus();
    await this.repository.writeStatus({ ...status, lastChannelFailedAt: failedAt }, now);
  }

  /**
   * Reads the state. A corrupt value counts as "no usable previous value" for a manual write (it
   * is named in history) and is flagged `corrupt` so a refresh can refuse to replace it.
   * Only CorruptSettingError is tolerated: a database outage must propagate.
   */
  private async readTolerant(db?: DbClient): Promise<{
    inputs: UsdRateInputs;
    snapshot: (now: Date) => Record<string, AuditValue>;
    corrupt: boolean;
  }> {
    try {
      const inputs = (await this.repository.readState(db)) ?? NO_INPUTS;
      return { inputs, snapshot: (now) => snapshotOf(inputs, now), corrupt: false };
    } catch (error) {
      if (!(error instanceof CorruptSettingError)) throw error;
      return {
        inputs: NO_INPUTS,
        snapshot: (now) => ({ ...snapshotOf(NO_INPUTS, now), rate: 'INVALID_STORED_VALUE' }),
        corrupt: true,
      };
    }
  }

  private view(state: UsdRateState | null, status: RefreshStatus): UsdRateView {
    const now = this.clock.now();
    const resolved = state && resolveUsdRate(state, now);
    const manual = state && manualInForce(state, now);
    return {
      rate: resolved?.rate ?? null,
      source: resolved?.source ?? null,
      rateDate: resolved?.rateDate ?? null,
      setBy: resolved?.setBy ?? null,
      updatedAt: state?.updatedAt ?? null,
      followsCentralBank: !manual,
      manualRate: manual?.rate ?? null,
      manualExpiresAt: manual?.expiresAt ?? null,
      lastRefreshFailedAt: status.lastFailedAt,
      lastChannelFailedAt: status.lastChannelFailedAt,
    };
  }
}

function isPlausible(rate: Prisma.Decimal): boolean {
  return rate.gte(USD_RATE_PLAUSIBLE_MIN) && rate.lte(USD_RATE_PLAUSIBLE_MAX);
}

function isFarFromBank(rate: Prisma.Decimal, bank: Prisma.Decimal): boolean {
  return rate.minus(bank).abs().div(bank).gt(CHANNEL_MAX_BANK_DIFFERENCE);
}
