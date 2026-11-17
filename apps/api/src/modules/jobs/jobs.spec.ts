import { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module.js';
import { NotificationsModule } from '../notifications/index.js';
import type { SyncReport } from '../sheets-sync/index.js';
import {
  enabledJobs,
  JOB_DEFINITIONS,
  JOB_NAMES,
  JOB_TIME_ZONE,
  type JobName,
} from './job-definitions.js';
import {
  createOutboxDispatchHandler,
  createSheetSyncHandler,
  createUsdRateRefreshHandler,
  JobFailedError,
  jobErrorCode,
  type JobLogger,
} from './job-handlers.js';
import { JobRuntime, SCHEDULE_KEY, type BossPort } from './job-runtime.js';
import { JobsModule } from './jobs.module.js';

// previewSchedule is pure cron arithmetic: no connection is opened until start().
const calendar = new PgBoss('postgres://nobody:nothing@127.0.0.1:1/none');

/** Occurrences of a job in [from, to) as `YYYY-MM-DD HH:MM` Tashkent wall-clock text. */
function tashkentOccurrences(name: JobName, fromUtc: string, toUtc: string): string[] {
  const to = new Date(toUtc).getTime();
  const format = new Intl.DateTimeFormat('sv-SE', {
    timeZone: JOB_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const found: string[] = [];
  let from = new Date(fromUtc);
  for (;;) {
    const page = calendar.previewSchedule(JOB_DEFINITIONS[name].cron, {
      tz: JOB_TIME_ZONE,
      from,
      count: 500,
    });
    const inside = page.filter((d) => d.getTime() < to);
    found.push(...inside.map((d) => format.format(d)));
    if (inside.length < page.length || page.length === 0) return found;
    from = page[page.length - 1] ?? from;
  }
}

// 2026-10-21 00:00 in Tashkent (UTC+5, no daylight saving) is 2026-10-20 19:00 UTC.
const DAY_START = '2026-10-20T19:00:00Z';
const DAY_END = '2026-10-21T19:00:00Z';

describe(
  'schedule definitions (fake clock = the `from` of the preview)',
  { timeout: 30_000 },
  () => {
    it('usd-rate-refresh: 09:05 and then every 15 minutes until 20:50 Tashkent', () => {
      const times = tashkentOccurrences('usd-rate-refresh', DAY_START, DAY_END).map((t) =>
        t.slice(11),
      );
      expect(times).toHaveLength(48);
      expect(times.slice(0, 4)).toEqual(['09:05', '09:20', '09:35', '09:50']);
      expect(times.at(-1)).toBe('20:50');
      expect(times.some((t) => t < '09:00' || t >= '21:00')).toBe(false);
    });

    it('sheet-sync: every 10 minutes around the clock', () => {
      // The preview excludes `from`, so it starts one minute before midnight.
      const times = tashkentOccurrences('sheet-sync', '2026-10-20T18:59:00Z', DAY_END).map((t) =>
        t.slice(11),
      );
      expect(times).toHaveLength(144);
      expect(times.slice(0, 3)).toEqual(['00:00', '00:10', '00:20']);
      expect(times.at(-1)).toBe('23:50');
    });

    it('runs on weekends too (2026-10-24 is a Saturday)', () => {
      const saturday = tashkentOccurrences(
        'sheet-sync',
        '2026-10-23T18:59:00Z',
        '2026-10-24T19:00:00Z',
      );
      expect(saturday).toHaveLength(144);
      expect(saturday[0]).toBe('2026-10-24 00:00');
    });

    it('is evaluated in Tashkent, not in the zone of the server', () => {
      const [first] = calendar.previewSchedule(JOB_DEFINITIONS['usd-rate-refresh'].cron, {
        tz: JOB_TIME_ZONE,
        from: new Date(DAY_START),
        count: 1,
      });
      // 09:05 in Tashkent is 04:05 UTC.
      expect(first?.toISOString()).toBe('2026-10-21T04:05:00.000Z');
    });

    it('outbox-dispatch: every minute', () => {
      const [a, b, c] = calendar.previewSchedule(JOB_DEFINITIONS['outbox-dispatch'].cron, {
        tz: JOB_TIME_ZONE,
        from: new Date(DAY_START),
        count: 3,
      });
      expect([b!.getTime() - a!.getTime(), c!.getTime() - b!.getTime()]).toEqual([60_000, 60_000]);
    });

    it('every job has a definition, one queue with the exclusive policy and no automatic retry', () => {
      expect([...JOB_NAMES].sort()).toEqual([
        'outbox-dispatch',
        'price-list-post',
        'sheet-sync',
        'usd-rate-refresh',
      ]);
      for (const name of JOB_NAMES) {
        const definition = JOB_DEFINITIONS[name];
        expect(definition.name).toBe(name);
        expect(definition.queue.policy).toBe('exclusive');
        expect(definition.queue.retryLimit).toBe(0);
      }
    });
  },
);

describe('enabledJobs', () => {
  const base = {
    JOBS_ENABLED: true,
    JOBS_USD_RATE_REFRESH_ENABLED: true,
    JOBS_SHEET_SYNC_ENABLED: true,
    JOBS_OUTBOX_DISPATCH_ENABLED: true,
    JOBS_PRICE_POST_ENABLED: true,
    TELEGRAM_MODE: 'webhook' as const,
    BOT_TOKEN: 'a-bot-token-value',
  };

  it('schedules nothing unless the master switch is on', () => {
    expect(enabledJobs({ ...base, JOBS_ENABLED: false })).toEqual([]);
  });

  it('needs the master switch AND the own switch', () => {
    expect(enabledJobs(base)).toEqual([
      'usd-rate-refresh',
      'sheet-sync',
      'outbox-dispatch',
      'price-list-post',
    ]);
    expect(enabledJobs({ ...base, JOBS_SHEET_SYNC_ENABLED: false })).toEqual([
      'usd-rate-refresh',
      'outbox-dispatch',
      'price-list-post',
    ]);
    expect(enabledJobs({ ...base, JOBS_PRICE_POST_ENABLED: false })).not.toContain(
      'price-list-post',
    );
  });

  it('does not register the outbox job when Telegram is off or has no token', () => {
    expect(enabledJobs({ ...base, TELEGRAM_MODE: 'off' })).not.toContain('outbox-dispatch');
    expect(enabledJobs({ ...base, BOT_TOKEN: undefined })).not.toContain('outbox-dispatch');
    expect(enabledJobs({ ...base, TELEGRAM_MODE: 'polling' })).toContain('outbox-dispatch');
  });
});

function recordingLogger(): JobLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (m) => lines.push(m),
    warn: (m) => lines.push(m),
  };
}

describe('usd-rate-refresh handler', () => {
  const refreshFromChannel = vi.fn().mockResolvedValue({ outcome: 'NO_POST_TODAY' });

  it('calls refreshIfDue with the clock time and logs only the outcome', async () => {
    const now = new Date('2026-10-21T04:05:00Z');
    const refreshIfDue = vi.fn().mockResolvedValue({ due: true, outcome: 'UPDATED' });
    const logger = recordingLogger();
    await createUsdRateRefreshHandler({
      refresher: { refreshIfDue },
      channel: { refreshFromChannel },
      clock: { now: () => now },
      logger,
    })();
    expect(refreshIfDue).toHaveBeenCalledWith(now);
    expect(logger.lines).toEqual([
      'usd-rate-refresh: UPDATED',
      'usd-rate-refresh: channel NO_POST_TODAY',
    ]);
  });

  it('reads the channel also when the bank is not due', async () => {
    const refreshIfDue = vi
      .fn()
      .mockResolvedValue({ due: false, reason: 'ALREADY_REFRESHED_TODAY' });
    const logger = recordingLogger();
    await createUsdRateRefreshHandler({
      refresher: { refreshIfDue },
      channel: { refreshFromChannel },
      clock: { now: () => new Date() },
      logger,
    })();
    expect(logger.lines).toEqual([
      'usd-rate-refresh: not due (ALREADY_REFRESHED_TODAY)',
      'usd-rate-refresh: channel NO_POST_TODAY',
    ]);
  });

  it('a failed bank call is a warning, not a job failure (the next tick retries)', async () => {
    const refreshIfDue = vi
      .fn()
      .mockResolvedValue({ due: true, outcome: 'FAILED', failure: 'TIMEOUT' });
    const logger = recordingLogger();
    await expect(
      createUsdRateRefreshHandler({
        refresher: { refreshIfDue },
        channel: {
          refreshFromChannel: vi
            .fn()
            .mockResolvedValue({ outcome: 'FAILED', failure: 'BAD_RESPONSE' }),
        },
        clock: { now: () => new Date() },
        logger,
      })(),
    ).resolves.toBeUndefined();
    expect(logger.lines).toEqual([
      'usd-rate-refresh: failed (TIMEOUT)',
      'usd-rate-refresh: channel failed (BAD_RESPONSE)',
    ]);
  });
});

const emptyReport = (): SyncReport => ({
  rowsRead: 7,
  skippedBySupplierFilter: [],
  created: 1,
  updated: 0,
  unchanged: 6,
  createdProducts: [],
  rejected: [],
  staleRefs: [],
  mismatches: [],
  derivedUsdCosts: [],
  stock: { created: 0, updated: 0, unchanged: 0 },
  categoriesChanged: 0,
  removals: { requested: 0, dismissed: 0 },
  reappearedAfterRemoval: [],
});

describe('sheet-sync handler', () => {
  it('skips and says so ONCE when the sheet source is not configured', async () => {
    const syncCostReference = vi.fn();
    const logger = recordingLogger();
    const handler = createSheetSyncHandler({
      sync: { syncCostReference },
      sourceConfigured: false,
      logger,
    });
    await handler();
    await handler();
    await handler();
    expect(syncCostReference).not.toHaveBeenCalled();
    expect(logger.lines).toEqual(['sheet-sync: sheet source not configured, runs are skipped']);
  });

  it('runs a SCHEDULED sync and logs counts only', async () => {
    const syncCostReference = vi.fn().mockResolvedValue(emptyReport());
    const logger = recordingLogger();
    await createSheetSyncHandler({ sync: { syncCostReference }, sourceConfigured: true, logger })();
    expect(syncCostReference).toHaveBeenCalledWith('SCHEDULED');
    expect(logger.lines[0]).toMatch(/^sheet-sync: done, rowsRead=7 /);
  });

  it('never overlaps itself inside one process', async () => {
    let release: () => void = () => undefined;
    const syncCostReference = vi.fn().mockImplementation(
      () =>
        new Promise<SyncReport>((resolve) => {
          release = () => {
            resolve(emptyReport());
          };
        }),
    );
    const logger = recordingLogger();
    const handler = createSheetSyncHandler({
      sync: { syncCostReference },
      sourceConfigured: true,
      logger,
    });
    const first = handler();
    await handler();
    expect(syncCostReference).toHaveBeenCalledTimes(1);
    expect(logger.lines).toContain('sheet-sync: the previous run is still going, skipped');
    release();
    await first;
    // After it finished, the next run goes ahead.
    const second = handler();
    release();
    await second;
    expect(syncCostReference).toHaveBeenCalledTimes(2);
  });

  it('fails the job with a code only: the original message (cost data!) is not kept', async () => {
    const error = Object.assign(new Error('Failing row contains (SECRET-COST 123.45)'), {
      code: 'SHEET_READ_AUTH',
    });
    const logger = recordingLogger();
    const handler = createSheetSyncHandler({
      sync: { syncCostReference: vi.fn().mockRejectedValue(error) },
      sourceConfigured: true,
      logger,
    });
    const thrown: unknown = await handler().then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(JobFailedError);
    expect((thrown as Error).message).toBe('Job sheet-sync failed (SHEET_READ_AUTH)');
    expect(`${(thrown as Error).stack} ${logger.lines.join(' ')}`).not.toContain('SECRET');
  });
});

describe('outbox-dispatch handler', () => {
  const summary = { claimed: 2, sent: 2, retried: 0, failed: 0, errors: 0 };

  it('does nothing when there is no dispatcher (Telegram off or no token)', async () => {
    const sleep = vi.fn();
    const logger = recordingLogger();
    await createOutboxDispatchHandler({
      dispatcher: null,
      passes: 2,
      pauseMs: 30_000,
      sleep,
      logger,
    })();
    expect(sleep).not.toHaveBeenCalled();
    expect(logger.lines[0]).toContain('Telegram is off or has no token');
  });

  it('makes the configured passes with a pause between them and checks grants once', async () => {
    const dispatcher = {
      runOnce: vi.fn().mockResolvedValue(summary),
      assertDeliveryGrants: vi.fn().mockResolvedValue(undefined),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const handler = createOutboxDispatchHandler({
      dispatcher,
      passes: 2,
      pauseMs: 30_000,
      sleep,
      logger: recordingLogger(),
    });
    await handler();
    await handler();
    expect(dispatcher.runOnce).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(dispatcher.assertDeliveryGrants).toHaveBeenCalledTimes(1);
  });

  it('skips the remaining passes when a shutdown began during the pause', async () => {
    const dispatcher = {
      runOnce: vi.fn().mockResolvedValue(summary),
      assertDeliveryGrants: vi.fn().mockResolvedValue(undefined),
    };
    let stopping = false;
    const sleep = vi.fn(() => {
      stopping = true;
      return Promise.resolve();
    });
    await createOutboxDispatchHandler({
      dispatcher,
      passes: 3,
      pauseMs: 30_000,
      sleep,
      isStopping: () => stopping,
      logger: recordingLogger(),
    })();
    expect(dispatcher.runOnce).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the role lacks the delivery grants', async () => {
    const dispatcher = {
      runOnce: vi.fn(),
      assertDeliveryGrants: vi.fn().mockRejectedValue(new Error('may not update status')),
    };
    await expect(
      createOutboxDispatchHandler({
        dispatcher,
        passes: 2,
        pauseMs: 0,
        sleep: vi.fn(),
        logger: recordingLogger(),
      })(),
    ).rejects.toBeInstanceOf(JobFailedError);
    expect(dispatcher.runOnce).not.toHaveBeenCalled();
  });
});

describe('jobErrorCode', () => {
  it('keeps identifier-like codes and nothing else', () => {
    expect(jobErrorCode({ code: 'SHEET_READ_QUOTA' })).toBe('SHEET_READ_QUOTA');
    expect(jobErrorCode({ code: 'has spaces and DETAIL: row' })).toBe('UNEXPECTED_ERROR');
    expect(jobErrorCode(new Error('x'))).toBe('UNEXPECTED_ERROR');
    expect(jobErrorCode('string')).toBe('UNEXPECTED_ERROR');
  });
});

function fakeBoss(
  existingQueues: readonly string[] = JOB_NAMES,
): BossPort & { calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const queues = new Set(existingQueues);
  const boss = {
    calls,
    start: vi.fn(() => {
      calls.push(['start']);
      return Promise.resolve(boss);
    }),
    stop: vi.fn((options: unknown) => {
      calls.push(['stop', options]);
      return Promise.resolve();
    }),
    on: vi.fn(() => boss),
    getQueue: vi.fn((name: string) => Promise.resolve(queues.has(name) ? { name } : null)),
    createQueue: vi.fn((name: string, options: unknown) => {
      queues.add(name);
      calls.push(['createQueue', name, options]);
      return Promise.resolve();
    }),
    updateQueue: vi.fn((name: string) => {
      calls.push(['updateQueue', name]);
      return Promise.resolve();
    }),
    schedule: vi.fn((name: string, cron: string, data: unknown, options: unknown) => {
      calls.push(['schedule', name, cron, data, options]);
      return Promise.resolve();
    }),
    unschedule: vi.fn((name: string, key: unknown) => {
      calls.push(['unschedule', name, key]);
      return Promise.resolve();
    }),
    work: vi.fn((name: string) => {
      calls.push(['work', name]);
      return Promise.resolve('worker-id');
    }),
  };
  return boss as unknown as BossPort & { calls: [string, ...unknown[]][] };
}

const noopHandlers: Record<JobName, () => Promise<void>> = {
  'usd-rate-refresh': () => Promise.resolve(),
  'sheet-sync': () => Promise.resolve(),
  'outbox-dispatch': () => Promise.resolve(),
  'price-list-post': () => Promise.resolve(),
};

describe('JobRuntime', () => {
  it('registers only the enabled jobs, in Tashkent time, and unschedules the others', async () => {
    const boss = fakeBoss();
    const runtime = new JobRuntime(boss, {
      enabled: ['sheet-sync'],
      handlers: noopHandlers,
      logger: recordingLogger(),
    });
    await runtime.start();
    expect(boss.calls.filter(([c]) => c === 'schedule')).toEqual([
      [
        'schedule',
        'sheet-sync',
        '*/10 * * * *',
        null,
        { tz: 'Asia/Tashkent', key: SCHEDULE_KEY, missed: 'once' },
      ],
    ]);
    expect(boss.calls.filter(([c]) => c === 'work').map((c) => c[1])).toEqual(['sheet-sync']);
    expect(boss.calls.filter(([c]) => c === 'unschedule').map((c) => c[1])).toEqual([
      'usd-rate-refresh',
      'outbox-dispatch',
      'price-list-post',
    ]);
  });

  it('with the master switch off schedules and works nothing at all', async () => {
    const boss = fakeBoss();
    await new JobRuntime(boss, {
      enabled: enabledJobs({
        JOBS_ENABLED: false,
        JOBS_USD_RATE_REFRESH_ENABLED: true,
        JOBS_SHEET_SYNC_ENABLED: true,
        JOBS_OUTBOX_DISPATCH_ENABLED: true,
        JOBS_PRICE_POST_ENABLED: true,
        TELEGRAM_MODE: 'webhook',
        BOT_TOKEN: 'a-bot-token-value',
      }),
      handlers: noopHandlers,
      logger: recordingLogger(),
    }).start();
    expect(boss.calls.some(([c]) => c === 'schedule' || c === 'work' || c === 'createQueue')).toBe(
      false,
    );
  });

  it('only updates existing queues (idempotent) and never creates one', async () => {
    const boss = fakeBoss(['sheet-sync', 'usd-rate-refresh']);
    const options = {
      enabled: ['sheet-sync', 'usd-rate-refresh'] as JobName[],
      handlers: noopHandlers,
      logger: recordingLogger(),
    };
    await new JobRuntime(boss, options).start();
    await new JobRuntime(boss, options).start();
    expect(boss.calls.filter(([c]) => c === 'updateQueue')).toHaveLength(4);
    expect(boss.calls.some(([c]) => c === 'createQueue')).toBe(false);
  });

  it('fails with a fixed "run jobs:migrate" text when a queue is missing, creating nothing', async () => {
    const boss = fakeBoss([]);
    const start = new JobRuntime(boss, {
      enabled: ['sheet-sync'],
      handlers: noopHandlers,
      logger: recordingLogger(),
    }).start();
    await expect(start).rejects.toThrow(
      'A job queue is missing in the pgboss schema: run jobs:migrate',
    );
    expect(boss.calls.some(([c]) => c === 'createQueue' || c === 'schedule')).toBe(false);
  });

  it('stops gracefully with a bounded wait', async () => {
    const boss = fakeBoss();
    await new JobRuntime(boss, {
      enabled: [],
      handlers: noopHandlers,
      logger: recordingLogger(),
    }).stop();
    expect(boss.calls.find(([c]) => c === 'stop')?.[1]).toEqual({
      graceful: true,
      close: true,
      timeout: 60_000,
    });
  });

  it('logs a pg-boss error by its name only', async () => {
    const boss = fakeBoss();
    const logger = recordingLogger();
    await new JobRuntime(boss, { enabled: [], handlers: noopHandlers, logger }).start();
    const listener = vi.mocked(boss.on).mock.calls[0]?.[1] as (e: unknown) => void;
    listener(Object.assign(new Error('INSERT ... VALUES (SECRET)'), { name: 'DatabaseError' }));
    expect(logger.lines).toContain('pg-boss error (DatabaseError)');
    expect(logger.lines.join(' ')).not.toContain('SECRET');
  });
});

describe('module wiring', () => {
  it('loads the notifications (and so the Telegram sender) only when Telegram is usable', () => {
    const off = JobsModule.register({ TELEGRAM_MODE: 'off', BOT_TOKEN: 'a-bot-token-value' });
    expect(off.imports).not.toContain(NotificationsModule);
    const noToken = JobsModule.register({ TELEGRAM_MODE: 'webhook', BOT_TOKEN: undefined });
    expect(noToken.imports).not.toContain(NotificationsModule);
    const on = JobsModule.register({ TELEGRAM_MODE: 'polling', BOT_TOKEN: 'a-bot-token-value' });
    expect(on.imports).toContain(NotificationsModule);
  });

  it('the API process does not import the jobs module', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const names = imports.map(
      (m) => (m as { name?: string; module?: { name: string } }).name ?? '',
    );
    expect(names).not.toContain('JobsModule');
  });
});
