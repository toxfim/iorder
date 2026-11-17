import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { Clock } from '../../common/clock/clock.js';
import { APP_ENV } from '../../config/config.module.js';
import { isSheetSourceConfigured, type Env } from '../../config/env.js';
import { OutboxDispatcher } from '../notifications/index.js';
import { PriceListPostService, RateRefreshService, UsdRateService } from '../pricing/index.js';
import { SheetsSyncService } from '../sheets-sync/index.js';
import { isTelegramSendingEnabled } from '../telegram/index.js';
import {
  enabledJobs,
  OUTBOX_PASS_PAUSE_MS,
  OUTBOX_PASSES_PER_RUN,
  type JobName,
} from './job-definitions.js';
import {
  createOutboxDispatchHandler,
  createPriceListPostHandler,
  createSheetSyncHandler,
  createUsdRateRefreshHandler,
  type JobHandler,
} from './job-handlers.js';
import { JobRuntime } from './job-runtime.js';
import { createWorkerBoss } from './pg-boss-factory.js';

/** Wires the real services into the job handlers and owns the pg-boss runtime of this process. */
@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');
  private runtime: JobRuntime | null = null;
  private readonly stopping = new AbortController();

  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    private readonly clock: Clock,
    private readonly rates: RateRefreshService,
    private readonly usdRate: UsdRateService,
    private readonly sheetSync: SheetsSyncService,
    private readonly priceListPosts: PriceListPostService,
    // Absent when the worker did not load the notifications module (Telegram off / no token).
    @Optional() @Inject(OutboxDispatcher) private readonly dispatcher: OutboxDispatcher | null,
  ) {}

  handlers(): Record<JobName, JobHandler> {
    const logger = this.logger;
    return {
      'usd-rate-refresh': createUsdRateRefreshHandler({
        refresher: this.rates,
        channel: this.usdRate,
        clock: this.clock,
        logger,
      }),
      'sheet-sync': createSheetSyncHandler({
        sync: this.sheetSync,
        sourceConfigured: isSheetSourceConfigured(this.env),
        logger,
      }),
      'outbox-dispatch': createOutboxDispatchHandler({
        dispatcher: isTelegramSendingEnabled(this.env) ? (this.dispatcher ?? null) : null,
        passes: OUTBOX_PASSES_PER_RUN,
        pauseMs: OUTBOX_PASS_PAUSE_MS,
        isStopping: () => this.stopping.signal.aborted,
        // Interrupted by a shutdown, so a stopping worker does not wait out the pause.
        // The handler then skips the second pass instead of starting new work while stopping.
        sleep: (ms) =>
          delay(ms, undefined, { signal: this.stopping.signal }).catch(() => undefined),
        logger,
      }),
      'price-list-post': createPriceListPostHandler({ posts: this.priceListPosts, logger }),
    };
  }

  async start(connectionString: string): Promise<void> {
    if (this.runtime !== null) throw new Error('Jobs are already started');
    this.runtime = new JobRuntime(createWorkerBoss(connectionString), {
      enabled: enabledJobs(this.env),
      handlers: this.handlers(),
      logger: this.logger,
    });
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.runtime?.stop();
    this.runtime = null;
  }
}
