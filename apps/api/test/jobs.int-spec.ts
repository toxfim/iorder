import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_DEFINITIONS, JOB_NAMES, type JobName } from '../src/modules/jobs/job-definitions.js';
import { JobRuntime } from '../src/modules/jobs/job-runtime.js';
import { createWorkerBoss, migrateJobsSchema } from '../src/modules/jobs/pg-boss-factory.js';
import { getRestrictedRoleUrl, getTestDatabaseUrl, APP_ROLE_NAME } from './support/test-env.js';

// pg-boss runs in its OWN throw-away schema of iorder_test (never `pgboss`, never `public`), made
// by the migrator (owner) step and dropped at the end. The two workers connect as the RESTRICTED
// non-owner role the production grants file is applied to, so this also proves the story in
// docs/private/architecture/production-db-roles.md. The services behind the handlers are fakes.

const SCHEMA = `pgboss_it_${randomBytes(4).toString('hex')}`;

function grantsSql(): string {
  const file = readFileSync(new URL('../db/pgboss-grants.sql', import.meta.url), 'utf8');
  return file
    .replaceAll(':"app_role"', `"${APP_ROLE_NAME}"`)
    .replaceAll(':"jobs_schema"', `"${SCHEMA}"`);
}

const silent = { log: () => undefined, warn: () => undefined };

function counters(): Record<JobName, number> {
  return { 'usd-rate-refresh': 0, 'sheet-sync': 0, 'outbox-dispatch': 0, 'price-list-post': 0 };
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 40_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the condition');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('pg-boss scheduler on real PostgreSQL', () => {
  const owner = new pg.Client({ connectionString: getTestDatabaseUrl() });
  let producer: PgBoss;
  const executed = counters();
  const runtimes: JobRuntime[] = [];

  const handlers = (): Record<JobName, () => Promise<void>> => {
    const handle = (name: JobName) => (): Promise<void> => {
      executed[name] += 1;
      return Promise.resolve();
    };
    return {
      'usd-rate-refresh': handle('usd-rate-refresh'),
      'sheet-sync': handle('sheet-sync'),
      'outbox-dispatch': handle('outbox-dispatch'),
      'price-list-post': handle('price-list-post'),
    };
  };

  function worker(enabled: JobName[] = [...JOB_NAMES]): JobRuntime {
    const runtime = new JobRuntime(createWorkerBoss(getRestrictedRoleUrl(), SCHEMA), {
      enabled,
      handlers: handlers(),
      logger: silent,
    });
    runtimes.push(runtime);
    return runtime;
  }

  beforeAll(async () => {
    await owner.connect();
    // The migrator step: creates the schema and the queues (twice: it must be idempotent).
    await migrateJobsSchema(getTestDatabaseUrl(), SCHEMA);
    await migrateJobsSchema(getTestDatabaseUrl(), SCHEMA);
    await owner.query(grantsSql());
    producer = new PgBoss({
      connectionString: getTestDatabaseUrl(),
      schema: SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
      reindex: false,
    });
    producer.on('error', () => undefined);
    await producer.start();
  }, 120_000);

  afterAll(async () => {
    for (const runtime of runtimes) await runtime.stop().catch(() => undefined);
    await producer.stop({ graceful: false, close: true }).catch(() => undefined);
    await owner.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await owner.end();
  }, 120_000);

  it('the migrator step created the schema and one queue per job', async () => {
    const { rows } = await owner.query<{ name: string; policy: string }>(
      `SELECT name, policy FROM "${SCHEMA}".queue ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual([...JOB_NAMES].sort());
    expect(rows.every((r) => r.policy === 'exclusive')).toBe(true);
  });

  it('the worker refuses to start when the schema was never migrated, and creates nothing', async () => {
    const missing = `pgboss_missing_${randomBytes(4).toString('hex')}`;
    const boss = createWorkerBoss(getRestrictedRoleUrl(), missing);
    boss.on('error', () => undefined);
    await expect(boss.start()).rejects.toThrow();
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
    const { rowCount } = await owner.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
      missing,
    ]);
    expect(rowCount).toBe(0);
  }, 60_000);

  it('registers every schedule once (idempotent), in Tashkent time, with two workers', async () => {
    const a = worker();
    const b = worker();
    await Promise.all([a.start(), b.start()]);
    await a.stop();
    await b.stop();
    // A restart registers the same rows again.
    await worker().start();
    const { rows } = await owner.query<{
      name: string;
      key: string;
      cron: string;
      timezone: string;
    }>(`SELECT name, key, cron, timezone FROM "${SCHEMA}".schedule ORDER BY name`);
    expect(rows).toHaveLength(JOB_NAMES.length);
    for (const row of rows) {
      expect(row.key).toBe('default');
      expect(row.timezone).toBe('Asia/Tashkent');
      expect(row.cron).toBe(JOB_DEFINITIONS[row.name as JobName].cron);
    }
    await runtimes[runtimes.length - 1]?.stop();
  }, 120_000);

  it('runs each job exactly once with two concurrent workers', async () => {
    // Queue them BEFORE any worker is up; the exclusive policy refuses a second queued job.
    for (const name of JOB_NAMES) {
      expect(await producer.send(name, {})).toEqual(expect.any(String));
      expect(await producer.send(name, {})).toBeNull();
    }
    const a = worker();
    const b = worker();
    await Promise.all([a.start(), b.start()]);

    await waitFor(() => JOB_NAMES.every((name) => executed[name] >= 1));
    // Give a would-be duplicate time to show up.
    await sleep(8_000);
    expect(executed).toEqual({
      'usd-rate-refresh': 1,
      'sheet-sync': 1,
      'outbox-dispatch': 1,
      'price-list-post': 1,
    });

    const { rows } = await owner.query<{ name: string; state: string }>(
      `SELECT name, state FROM "${SCHEMA}".job WHERE name = ANY($1)`,
      [[...JOB_NAMES]],
    );
    expect(rows.filter((r) => r.state === 'completed')).toHaveLength(JOB_NAMES.length);
    await a.stop();
    await b.stop();
  }, 120_000);

  it('a stopping worker lets the running job finish (graceful shutdown)', async () => {
    let started = false;
    let finished = false;
    const runtime = new JobRuntime(createWorkerBoss(getRestrictedRoleUrl(), SCHEMA), {
      enabled: ['sheet-sync'],
      handlers: {
        ...handlers(),
        'sheet-sync': async () => {
          started = true;
          await sleep(3_000);
          finished = true;
        },
      },
      logger: silent,
    });
    runtimes.push(runtime);
    await runtime.start();
    await producer.send('sheet-sync', {});
    await waitFor(() => started);
    await runtime.stop();
    expect(finished).toBe(true);
  }, 120_000);

  it('a maintenance pass as the restricted role needs no DDL and changes no table', async () => {
    const relations = async (): Promise<string[]> => {
      const { rows } = await owner.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 ORDER BY c.relname`,
        [SCHEMA],
      );
      return rows.map((r) => r.relname);
    };
    const before = await relations();
    const boss = createWorkerBoss(getRestrictedRoleUrl(), SCHEMA);
    const errors: unknown[] = [];
    boss.on('error', (error: unknown) => errors.push(error));
    await boss.start();
    try {
      // supervise() is the maintenance entry point (expire, archive, delete, cache stats); the
      // scheduled timer calls the same code, so one explicit pass proves the grants suffice.
      await boss.supervise();
      for (const name of JOB_NAMES) await boss.supervise(name);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
    expect(errors).toEqual([]);
    expect(await relations()).toEqual(before);
  }, 60_000);

  it('switching a job off removes its schedule', async () => {
    const runtime = worker(['sheet-sync']);
    await runtime.start();
    const { rows } = await owner.query<{ name: string }>(
      `SELECT name FROM "${SCHEMA}".schedule ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['sheet-sync']);
    await runtime.stop();
  }, 60_000);
});
