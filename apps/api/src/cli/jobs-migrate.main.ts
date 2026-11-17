import { migrateJobsSchema } from '../modules/jobs/index.js';

// Entry point of `pnpm --filter @iorder/api jobs:migrate`: creates or upgrades the `pgboss` schema
// and the three queues. It needs the right to create schemas and tables, so run it with the
// MIGRATOR / owner connection (docs/private/architecture/production-db-roles.md), never the application
// role: MIGRATOR_DATABASE_URL if set, else DATABASE_URL (development, where one role does both).
// Idempotent. Prints no connection string.
async function main(): Promise<number> {
  const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.error('Set MIGRATOR_DATABASE_URL (or DATABASE_URL) to a PostgreSQL connection URL.');
    return 1;
  }
  await migrateJobsSchema(url);
  console.log('The pg-boss schema and the job queues are ready.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A connection error message can contain the URL: print only the error name.
    console.error(`jobs:migrate failed (${error instanceof Error ? error.name : 'error'})`);
    process.exitCode = 1;
  },
);
