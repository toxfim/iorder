import { Injectable } from '@nestjs/common';
import { CorruptSettingError } from '../../../common/errors/domain-errors.js';
import { UsdRateRepository } from './usd-rate.repository.js';
import { tashkentDay, UsdRateService, type RefreshOutcome } from './usd-rate.service.js';

/** After a failed attempt, do not try again for this long (no retry storm from a busy scheduler). */
export const REFRESH_RETRY_AFTER_MS = 30 * 60_000;

export type RefreshIfDueResult =
  | { due: false; reason: 'ALREADY_REFRESHED_TODAY' | 'RETRY_LATER' | 'CORRUPT_STORED_RATE' }
  | ({ due: true } & RefreshOutcome);

/**
 * Decides WHEN to ask the Central Bank, so a scheduler can call it later with nothing else to know.
 * At most one successful refresh per Tashkent calendar day, also under a manual or a channel rate
 * (the bank is what the rate falls back to). Called by the `usd-rate-refresh` job of the worker
 * (modules/jobs; off by default), which also reads the channel on every tick.
 *
 * OPEN PRODUCT QUESTION: the refresh moment. The job runs at 09:05 Tashkent and every 15 minutes
 * after that until 21:00 [P]; alternative: when a draft price list is created.
 */
@Injectable()
export class RateRefreshService {
  constructor(
    private readonly rates: UsdRateService,
    private readonly repository: UsdRateRepository,
  ) {}

  async refreshIfDue(now: Date): Promise<RefreshIfDueResult> {
    try {
      await this.repository.readState();
    } catch (error) {
      // Only a corrupt value is a typed result; a database outage must reach the caller.
      if (error instanceof CorruptSettingError)
        return { due: false, reason: 'CORRUPT_STORED_RATE' };
      throw error;
    }

    const status = await this.repository.readStatus();
    if (status.lastSuccessDay === tashkentDay(now)) {
      return { due: false, reason: 'ALREADY_REFRESHED_TODAY' };
    }
    if (
      status.lastFailedAt &&
      now.getTime() - status.lastFailedAt.getTime() < REFRESH_RETRY_AFTER_MS
    ) {
      return { due: false, reason: 'RETRY_LATER' };
    }
    return { due: true, ...(await this.rates.refreshFromCentralBank()) };
  }
}
