import type { SheetSyncRequestOutcome } from '@iorder/shared/staff-cost';
import { PgBoss } from 'pg-boss';
import { ConflictError } from '../../common/errors/domain-errors.js';

/**
 * How the api asks the worker for one sheet sync now ("sync now" button). The sync itself never
 * runs inside a request (CLAUDE.md: side effects go through the job queue): the api only puts a
 * job in the worker's `sheet-sync` queue, whose `exclusive` policy keeps at most one job queued
 * or active, so hammering the button cannot pile up runs.
 */
export abstract class SheetSyncQueue {
  abstract request(): Promise<SheetSyncRequestOutcome>;
}

/** The queue name and payload the worker's handler understands (`isManualSheetSyncRequest`). */
export const SHEET_SYNC_QUEUE = 'sheet-sync';
const MANUAL_REQUEST = Object.freeze({ trigger: 'MANUAL' });

/** The part of pg-boss the sender uses, so a unit test can pass a fake. */
export type SenderBossPort = Pick<PgBoss, 'start' | 'stop' | 'on' | 'send'>;

/**
 * A pg-boss client that only SENDS: no scheduler, no supervision, no migration (the schema belongs
 * to the migrator role and the cron to the worker). Started lazily on the first request and
 * stopped with the module. Its one connection pool stays small on purpose.
 */
export function createSenderBoss(connectionString: string, schema: string): SenderBossPort {
  return new PgBoss({
    connectionString,
    schema,
    application_name: 'iorder-api-sender',
    max: 2,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  });
}

export class PgBossSheetSyncQueue extends SheetSyncQueue {
  private starting: Promise<void> | null = null;

  constructor(private readonly boss: SenderBossPort) {
    super();
  }

  async request(): Promise<SheetSyncRequestOutcome> {
    await this.ensureStarted();
    // `exclusive` queue policy: pg-boss answers null instead of a job id when one is already
    // queued or active, which is exactly "already queued" for the person who pressed the button.
    const id = await this.boss.send(SHEET_SYNC_QUEUE, MANUAL_REQUEST);
    return id === null ? 'ALREADY_QUEUED' : 'QUEUED';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.starting === null) return;
    await this.boss.stop({ graceful: false, close: true });
  }

  private ensureStarted(): Promise<void> {
    if (this.starting === null) {
      // Errors of the pool are swallowed here: the request that hits them gets its own rejection
      // and the generic 500; the connection string must never reach a log through pg-boss.
      this.boss.on('error', () => undefined);
      this.starting = this.boss.start().then(() => undefined);
      this.starting.catch(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }
}

/** With the worker jobs switched off there is nobody to run a sync: a clear 409, not a silent no-op. */
export class UnavailableSheetSyncQueue extends SheetSyncQueue {
  request(): Promise<SheetSyncRequestOutcome> {
    return Promise.reject(
      new ConflictError('The sheet sync worker is switched off', 'SHEET_SYNC_QUEUE_UNAVAILABLE'),
    );
  }
}
