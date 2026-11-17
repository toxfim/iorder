import type { Tx } from './db-client.js';

/**
 * Namespace (the first int of the two-int form) for every advisory lock this application takes.
 * Libraries that also use advisory locks (a job queue, a migration tool) pick their own keys; a
 * dedicated class id keeps our `hashtext(name)` keys from ever colliding with theirs. Arbitrary
 * but fixed: never change it while the application is running in production.
 */
export const APP_ADVISORY_LOCK_CLASS = 1_047_001;

/**
 * Transaction-scoped advisory lock on a NAME: waits for a concurrent holder, no table rows are
 * locked, and it is released automatically at commit or rollback.
 */
export async function lockByName(tx: Tx, name: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APP_ADVISORY_LOCK_CLASS}::int, hashtext(${name}))`;
}
