import pg from 'pg';

/**
 * Integration runs from different worktrees share ONE database (iorder_test). Two overlapping
 * runs corrupt each other's data (and the random password of the restricted role). So a run takes
 * a session-level advisory lock, on a dedicated connection, before it migrates or touches the
 * database, and keeps it until teardown. A second run WAITS (with a clear message) instead of
 * colliding. If a run dies, its connection closes and PostgreSQL releases the lock by itself.
 *
 * Two-int form: (class, key). The class namespaces our test locks; Prisma's own migrate lock uses
 * the single-int form and cannot collide with it.
 */
export const TEST_DB_LOCK_CLASS = 1_047_900;
export const TEST_DB_LOCK_KEY = 1;

export const DEFAULT_LOCK_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 500;

export interface LockOptions {
  /** Defaults to the whole-run key; tests of the lock itself use their own key. */
  key?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** Called once, when the lock is busy and we start waiting. */
  onWait?: () => void;
  /**
   * Called if the lock-holding connection breaks AFTER the lock was acquired (a PostgreSQL or Docker
   * restart, a network drop): the lock is gone and another run may already be using the database.
   * The default reports it loudly and marks the process as failed.
   */
  onLost?: (error: Error) => void;
}

export class TestDatabaseLockLostError extends Error {}

function defaultOnLost(error: Error): void {
  console.error(
    `The integration test database lock was LOST (${error.message}). Another run may be using the ` +
      'database now; this run cannot be trusted. Failing the run.',
  );
  process.exitCode = 1;
}

export class TestDatabaseBusyError extends Error {}

/** Resolves with a `release` function once the lock is held; rejects after `timeoutMs`. */
export async function acquireTestDbLock(
  connectionString: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const key = options.key ?? TEST_DB_LOCK_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;

  const client = new pg.Client({ connectionString });
  // Without a listener an error on an idle client would be an unhandled 'error' event. With the
  // lock held, it means the lock is lost: say so loudly and fail the run (see release below).
  let held = false;
  let lost: Error | null = null;
  client.on('error', (error: Error) => {
    // Before the lock is held, connect()/query() reject on their own. Report the loss only once.
    if (!held || lost !== null) return;
    lost = error;
    (options.onLost ?? defaultOnLost)(error);
  });
  await client.connect();
  const started = Date.now();
  let announced = false;
  try {
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [TEST_DB_LOCK_CLASS, key],
      );
      if (rows[0]?.locked) {
        held = true;
        break;
      }
      if (!announced) {
        announced = true;
        options.onWait?.();
      }
      if (Date.now() - started >= timeoutMs) {
        throw new TestDatabaseBusyError(
          `The test database is in use by another integration run (advisory lock ` +
            `${TEST_DB_LOCK_CLASS}/${key} held). Gave up after ${Math.round(timeoutMs / 1000)} s. ` +
            `Wait for the other run to finish, or raise IORDER_TEST_DB_LOCK_TIMEOUT_MS.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  return async () => {
    if (lost !== null) {
      await client.end().catch(() => undefined);
      throw new TestDatabaseLockLostError(
        `The integration test database lock was lost during the run: ${(lost as Error).message}`,
      );
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [TEST_DB_LOCK_CLASS, key]);
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}
