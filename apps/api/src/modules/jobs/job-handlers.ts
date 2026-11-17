import type { Clock } from '../../common/clock/clock.js';
import type { OutboxDispatcher } from '../notifications/index.js';
import type { PriceListPostService, RateRefreshService, UsdRateService } from '../pricing/index.js';
import {
  formatSyncCounts,
  summarizeSyncReport,
  type SheetsSyncService,
} from '../sheets-sync/index.js';
import type { JobName } from './job-definitions.js';

/**
 * A job body. Thin on purpose: it calls an exported service and reports counters. `data` is the
 * payload of the pg-boss job: null for a scheduled occurrence, an object for a job somebody sent
 * (the "sync now" request); a handler must treat it as untrusted and ignore what it does not know.
 */
export type JobHandler = (data?: unknown) => Promise<void>;

/** The one payload the sheet-sync queue accepts from the api: a person asked for a run now. */
export function isManualSheetSyncRequest(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { trigger?: unknown }).trigger === 'MANUAL'
  );
}

export interface JobLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * What a failed job leaves behind in pg-boss' `job` table (it stores the thrown error's message
 * and stack). Only the job name and a stable code: a database or sheet error could carry cost
 * rows or SQL parameters, so the original is never rethrown.
 */
export class JobFailedError extends Error {
  constructor(job: JobName, code: string) {
    super(`Job ${job} failed (${code})`);
    this.name = 'JobFailedError';
  }
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,63}$/;

/** The error's own `code` when it is an identifier, else a fixed fallback. Never the message. */
export function jobErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  }
  return 'UNEXPECTED_ERROR';
}

export function createUsdRateRefreshHandler(deps: {
  refresher: Pick<RateRefreshService, 'refreshIfDue'>;
  channel: Pick<UsdRateService, 'refreshFromChannel'>;
  clock: Clock;
  logger: JobLogger;
}): JobHandler {
  return async () => {
    const result = await deps.refresher.refreshIfDue(deps.clock.now());
    if (!result.due) {
      deps.logger.log(`usd-rate-refresh: not due (${result.reason})`);
    } else if (result.outcome === 'FAILED') {
      // The failure time is already stored by the rate service; the next tick retries.
      deps.logger.warn(`usd-rate-refresh: failed (${result.failure})`);
    } else {
      deps.logger.log(`usd-rate-refresh: ${result.outcome}`);
    }
    // After the bank: a channel post is checked against the bank's rate of the day.
    const channel = await deps.channel.refreshFromChannel();
    if (channel.outcome === 'FAILED') {
      deps.logger.warn(`usd-rate-refresh: channel failed (${channel.failure})`);
    } else {
      deps.logger.log(`usd-rate-refresh: channel ${channel.outcome}`);
    }
  };
}

export function createSheetSyncHandler(deps: {
  sync: Pick<SheetsSyncService, 'syncCostReference'>;
  sourceConfigured: boolean;
  logger: JobLogger;
}): JobHandler {
  let warnedUnconfigured = false;
  // The queue policy already forbids two active runs across workers; this also covers a handler
  // called twice inside one process.
  let running = false;
  return async (data) => {
    if (!deps.sourceConfigured) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        deps.logger.warn('sheet-sync: sheet source not configured, runs are skipped');
      }
      return;
    }
    if (running) {
      deps.logger.warn('sheet-sync: the previous run is still going, skipped');
      return;
    }
    running = true;
    try {
      // A failed run is recorded in `sheet_sync_runs` by the sync itself. The trigger tells the
      // report whether the cron or a person ("sync now") started this run.
      const trigger = isManualSheetSyncRequest(data) ? 'MANUAL' : 'SCHEDULED';
      const report = await deps.sync.syncCostReference(trigger);
      deps.logger.log(`sheet-sync: done, ${formatSyncCounts(summarizeSyncReport(report))}`);
    } catch (error) {
      const code = jobErrorCode(error);
      deps.logger.warn(`sheet-sync: failed (${code})`);
      throw new JobFailedError('sheet-sync', code);
    } finally {
      running = false;
    }
  };
}

export function createPriceListPostHandler(deps: {
  posts: Pick<PriceListPostService, 'postDaily'>;
  logger: JobLogger;
}): JobHandler {
  return async () => {
    try {
      const result = await deps.posts.postDaily();
      if (result.outcome === 'NOTHING_PUBLISHED') {
        deps.logger.log('price-list-post: nothing published, skipped');
        return;
      }
      deps.logger.log(
        `price-list-post: version ${result.versionNumber}, queued for ${result.queuedGroupCount} groups`,
      );
    } catch (error) {
      const code = jobErrorCode(error);
      deps.logger.warn(`price-list-post: failed (${code})`);
      throw new JobFailedError('price-list-post', code);
    }
  };
}

export function createOutboxDispatchHandler(deps: {
  /** Null when Telegram is off or has no token: the sender does not exist, nothing is sent. */
  dispatcher: Pick<OutboxDispatcher, 'runOnce' | 'assertDeliveryGrants'> | null;
  passes: number;
  pauseMs: number;
  sleep: (ms: number) => Promise<void>;
  /** True once a shutdown began: no further pass is started (the sleep ends early then). */
  isStopping?: () => boolean;
  logger: JobLogger;
}): JobHandler {
  let grantsChecked = false;
  return async () => {
    const dispatcher = deps.dispatcher;
    if (dispatcher === null) {
      deps.logger.warn('outbox-dispatch: Telegram is off or has no token, nothing is dispatched');
      return;
    }
    try {
      if (!grantsChecked) {
        // A role without the column grants would send a message and then be unable to record it,
        // so the same message would go out again on every pass.
        await dispatcher.assertDeliveryGrants();
        grantsChecked = true;
      }
      for (let pass = 1; pass <= deps.passes; pass += 1) {
        const summary = await dispatcher.runOnce();
        if (summary.claimed > 0 || summary.errors > 0) {
          deps.logger.log(
            `outbox-dispatch: claimed ${summary.claimed}, sent ${summary.sent}, retry ${summary.retried}, failed ${summary.failed}, errors ${summary.errors}`,
          );
        }
        if (pass < deps.passes) {
          await deps.sleep(deps.pauseMs);
          if (deps.isStopping?.() === true) break;
        }
      }
    } catch (error) {
      const code = jobErrorCode(error);
      deps.logger.warn(`outbox-dispatch: failed (${code})`);
      throw new JobFailedError('outbox-dispatch', code);
    }
  };
}
