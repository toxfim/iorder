import type { PgBoss } from 'pg-boss';
import {
  JOB_DEFINITIONS,
  JOB_NAMES,
  JOB_SHUTDOWN_TIMEOUT_MS,
  JOB_TIME_ZONE,
  type JobName,
} from './job-definitions.js';
import type { JobHandler, JobLogger } from './job-handlers.js';

/** The part of pg-boss the runtime uses, so a unit test can pass a fake. */
export type BossPort = Pick<
  PgBoss,
  'start' | 'stop' | 'on' | 'getQueue' | 'updateQueue' | 'schedule' | 'unschedule' | 'work'
>;

/** Fixed text on purpose: nothing from the database or the connection may end up in it. */
export class JobQueueMissingError extends Error {
  constructor() {
    super('A job queue is missing in the pgboss schema: run jobs:migrate');
    this.name = 'JobQueueMissingError';
  }
}

/** One fixed schedule key, so registering again updates the row instead of adding another. */
export const SCHEDULE_KEY = 'default';
/** Jobs are minute-level: a few seconds of pickup delay is irrelevant, polling hard is waste. */
const POLLING_INTERVAL_SECONDS = 5;

/**
 * Registers the enabled jobs with pg-boss and works them. Registration is idempotent (the queue is
 * created or updated, the schedule is an upsert keyed by name) and safe to run in many workers at
 * once: pg-boss sends each cron occurrence once, and the queue policy `exclusive` allows one
 * queued-or-active job per queue, so two workers never double-run a job.
 *
 * A job that is switched off has its schedule REMOVED here, so turning a switch off really stops
 * the job instead of leaving a schedule that fills the queue with nobody to work it.
 */
export class JobRuntime {
  constructor(
    private readonly boss: BossPort,
    private readonly options: {
      enabled: readonly JobName[];
      handlers: Partial<Record<JobName, JobHandler>>;
      logger: JobLogger;
    },
  ) {}

  async start(): Promise<void> {
    const { logger } = this.options;
    // Only the kind of failure: a pg-boss error can carry SQL text and parameters.
    this.boss.on('error', (error: unknown) => {
      const name = error instanceof Error ? error.name : 'unknown';
      logger.warn(`pg-boss error (${name})`);
    });
    await this.boss.start();

    for (const name of JOB_NAMES) {
      if (!this.options.enabled.includes(name)) {
        await this.boss.unschedule(name, SCHEDULE_KEY);
        continue;
      }
      await this.register(name);
    }
    logger.log(
      this.options.enabled.length === 0
        ? 'jobs: no job is enabled'
        : `jobs: running ${this.options.enabled.join(', ')} (time zone ${JOB_TIME_ZONE})`,
    );
  }

  /** Waits (bounded) for running jobs, then closes the pool. Safe to call more than once. */
  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, close: true, timeout: JOB_SHUTDOWN_TIMEOUT_MS });
  }

  private async register(name: JobName): Promise<void> {
    const definition = JOB_DEFINITIONS[name];
    const handler = this.options.handlers[name];
    if (handler === undefined) throw new Error(`No handler for job ${name}`);

    // The policy is fixed when the queue is created and cannot be updated.
    const { retryLimit, expireInSeconds, deleteAfterSeconds, retentionSeconds } = definition.queue;
    // The queue is created by `jobs:migrate` (owner role). The worker role has no DDL right, so it
    // must not try to create it: fail with a fixed, readable text instead of a database error.
    if ((await this.boss.getQueue(name)) === null) throw new JobQueueMissingError();
    await this.boss.updateQueue(name, {
      retryLimit,
      expireInSeconds,
      deleteAfterSeconds,
      retentionSeconds,
    });
    await this.boss.schedule(name, definition.cron, null, {
      tz: JOB_TIME_ZONE,
      key: SCHEDULE_KEY,
      missed: definition.missed,
    });
    await this.boss.work(
      name,
      { pollingIntervalSeconds: POLLING_INTERVAL_SECONDS, batchSize: 1, localConcurrency: 1 },
      async (jobs) => {
        // batchSize 1: one job per call. Its data is null for a cron occurrence.
        await handler(jobs[0]?.data);
      },
    );
  }
}
