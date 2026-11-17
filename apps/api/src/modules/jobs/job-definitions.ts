import type { Env } from '../../config/env.js';
import { isTelegramSendingEnabled } from '../telegram/index.js';

/**
 * ALL background job names, schedules and queue settings live in this file, in one place.
 *
 * Every schedule and window below is [P] (proposed, not confirmed by the owner) unless marked [C]:
 * see the work log and `docs/private/product/manager-questions.md`. Business time is Asia/Tashkent (hard rule 9): the cron
 * expressions are evaluated by pg-boss in that zone, so a daylight-saving change or a server in
 * another zone cannot move them.
 *
 * Nothing here runs by itself. Jobs are scheduled only by the separate worker process
 * (`pnpm --filter @iorder/api worker`), only when JOBS_ENABLED is true, and each job only when its
 * own switch is true as well.
 */
export const JOB_TIME_ZONE = 'Asia/Tashkent';

export const JOB_NAMES = [
  'usd-rate-refresh',
  'sheet-sync',
  'outbox-dispatch',
  'price-list-post',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JOB_SWITCHES = [
  'JOBS_USD_RATE_REFRESH_ENABLED',
  'JOBS_SHEET_SYNC_ENABLED',
  'JOBS_OUTBOX_DISPATCH_ENABLED',
  'JOBS_PRICE_POST_ENABLED',
] as const;
export type JobSwitch = (typeof JOB_SWITCHES)[number];

export interface JobDefinition {
  readonly name: JobName;
  /** Five-field cron, evaluated in JOB_TIME_ZONE. */
  readonly cron: string;
  readonly switch: JobSwitch;
  /** What pg-boss does with occurrences that came due while no worker ran (a deploy, a crash). */
  readonly missed: 'skip' | 'once';
  readonly queue: {
    /** `exclusive`: at most ONE job queued or active, so runs never overlap or pile up. */
    readonly policy: 'exclusive';
    /** Zero: the next scheduled tick is the retry, and a failure is already recorded elsewhere. */
    readonly retryLimit: number;
    /** A job that is still active after this long is expired (its worker is presumed dead). */
    readonly expireInSeconds: number;
    /** Finished jobs are deleted after this long (a job every minute must not pile up). */
    readonly deleteAfterSeconds: number;
    /** A job that was never picked up is deleted after this long. */
    readonly retentionSeconds: number;
  };
}

const ONE_DAY_SECONDS = 86_400;

export const JOB_DEFINITIONS: Record<JobName, JobDefinition> = {
  // Every 15 minutes at :05, :20, :35 and :50, 09:05 to 20:50 Tashkent. The first tick is the daily
  // refresh; the rest are the retries after a failure. `RateRefreshService.refreshIfDue` limits
  // itself to one success per Tashkent day. It also pauses 30 minutes
  // after a failure, and a tick arrives a few seconds before that pause ends, so with 15-minute
  // ticks the retry lands 30-45 minutes after the failure. A tick that is not due returns
  // RETRY_LATER and costs nothing (no Central Bank request).
  // Every tick also reads the Telegram channel's public page for today's rate.
  'usd-rate-refresh': {
    name: 'usd-rate-refresh',
    cron: '5,20,35,50 9-20 * * *',
    switch: 'JOBS_USD_RATE_REFRESH_ENABLED',
    missed: 'once',
    queue: {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 300,
      deleteAfterSeconds: ONE_DAY_SECONDS,
      retentionSeconds: 3600,
    },
  },
  // Every 10 minutes, around the clock, every day of the week [C, owner 2026-10-26]. Read-only:
  // the sync never writes to the sheet (hard rule 10).
  'sheet-sync': {
    name: 'sheet-sync',
    cron: '*/10 * * * *',
    switch: 'JOBS_SHEET_SYNC_ENABLED',
    missed: 'once',
    queue: {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 1800,
      deleteAfterSeconds: ONE_DAY_SECONDS,
      retentionSeconds: 3600,
    },
  },
  // Every minute; the handler makes `OUTBOX_PASSES_PER_RUN` passes, so the outbox is looked at
  // every 30 seconds (cron has minute resolution). Missed ticks are skipped: the next one drains
  // the backlog anyway.
  'outbox-dispatch': {
    name: 'outbox-dispatch',
    cron: '* * * * *',
    switch: 'JOBS_OUTBOX_DISPATCH_ENABLED',
    missed: 'skip',
    queue: {
      policy: 'exclusive',
      retryLimit: 0,
      // Two passes, each with the dispatcher's own five-minute time budget, plus the pause.
      expireInSeconds: 1000,
      deleteAfterSeconds: ONE_DAY_SECONDS,
      retentionSeconds: 600,
    },
  },
  // Every day at 09:00 Tashkent [P]: queues the price list Excel file for every organization group
  // with price posting on ([C] 2026-10-28; the time is proposed). At most once per group per
  // business day (the dedupe key carries the day), so a missed tick run late ('once') or a second
  // worker cannot post twice. The outbox job does the sending.
  'price-list-post': {
    name: 'price-list-post',
    cron: '0 9 * * *',
    switch: 'JOBS_PRICE_POST_ENABLED',
    missed: 'once',
    queue: {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 300,
      deleteAfterSeconds: ONE_DAY_SECONDS,
      retentionSeconds: 3600,
    },
  },
};

export const OUTBOX_PASSES_PER_RUN = 2;
export const OUTBOX_PASS_PAUSE_MS = 30_000;

/** How long a stopping worker waits for a running job before it gives up. */
export const JOB_SHUTDOWN_TIMEOUT_MS = 60_000;

/** The pg-boss tables live in their own schema of the same database. */
export const PGBOSS_SCHEMA = 'pgboss';

export type TelegramEnv = Parameters<typeof isTelegramSendingEnabled>[0];
type JobsEnv = Pick<Env, 'JOBS_ENABLED' | JobSwitch> & TelegramEnv;

/**
 * The jobs this process should schedule and work: master switch, own switch, preconditions. The
 * outbox job needs Telegram to be usable (mode not `off` and a bot token); without it the job is
 * not even registered, and the worker does not load the module that builds the sender.
 */
export function enabledJobs(env: JobsEnv): JobName[] {
  if (!env.JOBS_ENABLED) return [];
  return JOB_NAMES.filter((name) => {
    if (!env[JOB_DEFINITIONS[name].switch]) return false;
    // The sheet-sync job IS registered without a configured source: its handler logs once and
    // skips, so turning the source on later needs no re-registration (see sheet-sync handler).
    return name !== 'outbox-dispatch' || isTelegramSendingEnabled(env);
  });
}
