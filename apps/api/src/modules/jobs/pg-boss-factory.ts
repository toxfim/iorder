import { PgBoss } from 'pg-boss';
import { JOB_DEFINITIONS, JOB_NAMES, PGBOSS_SCHEMA } from './job-definitions.js';

/**
 * The worker's pg-boss. It never creates or migrates the `pgboss` schema (DDL belongs to the
 * migrator role, see docs/private/architecture/production-db-roles.md): `jobs:migrate` does that. Index
 * rebuilds (`REINDEX`) need table ownership, so they are off for the application role. The stats and
 * warnings history are pinned off explicitly: both create or prune partitioned tables, and a
 * future pg-boss default must not turn them on for a role that cannot run DDL.
 */
export function createWorkerBoss(connectionString: string, schema: string = PGBOSS_SCHEMA): PgBoss {
  return new PgBoss({
    connectionString,
    schema,
    application_name: 'iorder-worker',
    max: 5,
    migrate: false,
    createSchema: false,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  });
}

/**
 * Creates (or upgrades) the pg-boss schema and the queues. Run as the MIGRATOR / owner role, never
 * by the application role: `pnpm --filter @iorder/api jobs:migrate`. Idempotent. Starts no workers
 * and no scheduler.
 */
export async function migrateJobsSchema(
  connectionString: string,
  schema: string = PGBOSS_SCHEMA,
): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema,
    application_name: 'iorder-jobs-migrate',
    max: 2,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    reindex: false,
  });
  boss.on('error', () => undefined);
  try {
    await boss.start();
    for (const name of JOB_NAMES) {
      if ((await boss.getQueue(name)) === null) {
        await boss.createQueue(name, JOB_DEFINITIONS[name].queue);
      }
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}
