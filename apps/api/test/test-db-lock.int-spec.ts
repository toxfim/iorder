import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acquireTestDbLock,
  TestDatabaseLockLostError,
  TEST_DB_LOCK_CLASS,
  TEST_DB_LOCK_KEY,
  TestDatabaseBusyError,
} from './support/test-db-lock.js';
import { getTestDatabaseUrl } from './support/test-env.js';

// The lock keeps overlapping integration runs (other worktrees, other agents) from colliding on
// the shared database. This run itself holds it (taken in global setup).
describe('integration run lock', () => {
  const url = getTestDatabaseUrl();

  it('is held by this very run, in the two-int advisory form', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ classid: number; objid: number; objsubid: number }>(
        `SELECT classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid
         FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1`,
        [TEST_DB_LOCK_CLASS],
      );
      expect(rows).toEqual([{ classid: TEST_DB_LOCK_CLASS, objid: TEST_DB_LOCK_KEY, objsubid: 2 }]);
    } finally {
      await client.end();
    }
  });

  it('a second run waits, announces it, and gives up with a clear message', async () => {
    let announced = false;
    const started = Date.now();
    const failure = await acquireTestDbLock(url, {
      timeoutMs: 600,
      pollMs: 100,
      onWait: () => (announced = true),
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(TestDatabaseBusyError);
    expect(failure?.message).toMatch(/in use by another integration run/);
    expect(failure?.message).toMatch(/IORDER_TEST_DB_LOCK_TIMEOUT_MS/);
    expect(announced).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('a waiting run gets the lock as soon as the holder releases it (contention on a private key)', async () => {
    const key = 4242;
    const releaseFirst = await acquireTestDbLock(url, { key });
    let secondHasLock = false;
    const second = acquireTestDbLock(url, { key, timeoutMs: 10_000, pollMs: 50 }).then(
      (release) => {
        secondHasLock = true;
        return release;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(secondHasLock, 'must still be waiting while the first holds the lock').toBe(false);
    await releaseFirst();
    const releaseSecond = await second;
    expect(secondHasLock).toBe(true);
    await releaseSecond();
  });

  it('a lock-holding connection that breaks mid-run is reported loudly and fails the release', async () => {
    const key = 4244;
    const errors: Error[] = [];
    const release = await acquireTestDbLock(url, { key, onLost: (error) => errors.push(error) });
    const killer = new pg.Client({ connectionString: url });
    await killer.connect();
    try {
      // Simulates a PostgreSQL/Docker restart: the server drops the holder's connection.
      await killer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
         WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted`,
        [TEST_DB_LOCK_CLASS, key],
      );
    } finally {
      await killer.end();
    }
    for (let i = 0; i < 50 && errors.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errors).toHaveLength(1);
    await expect(release()).rejects.toBeInstanceOf(TestDatabaseLockLostError);
  });

  it('a lock is released when its connection dies (a crashed run cannot block the others)', async () => {
    const key = 4243;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [TEST_DB_LOCK_CLASS, key]);
    await client.end(); // simulates the process dying
    const release = await acquireTestDbLock(url, { key, timeoutMs: 3000, pollMs: 50 });
    await release();
  });
});
