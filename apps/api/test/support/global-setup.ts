import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { APP_ROLE_NAME, APP_ROLE_PASSWORD_ENV, getTestDatabaseUrl } from './test-env.js';
import { acquireTestDbLock, DEFAULT_LOCK_TIMEOUT_MS } from './test-db-lock.js';

/**
 * Brings the test database to the latest migration before any integration test runs, and
 * prepares the restricted application role used by the role-story test.
 */
export default async function setup(): Promise<() => Promise<void>> {
  // First of all: no other integration run may use the database while this one does.
  const release = await acquireTestDbLock(getTestDatabaseUrl(), {
    timeoutMs: Number(process.env.IORDER_TEST_DB_LOCK_TIMEOUT_MS ?? DEFAULT_LOCK_TIMEOUT_MS),
    onWait: () =>
      console.warn(
        'Test database is in use by another integration run; waiting for it to finish...',
      ),
  });
  try {
    await prepareDatabase();
  } catch (error) {
    await release();
    throw error;
  }
  // vitest calls the returned function after the whole run.
  return release;
}

async function prepareDatabase(): Promise<void> {
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: getTestDatabaseUrl() },
  });
  await ensureRestrictedAppRole();
}

/**
 * The production grants file with its psql variable `:"app_role"` replaced by the (validated,
 * quoted) role name; production substitutes it with psql (`-v app_role=...`).
 */
function appRoleGrantsSql(roleName: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) throw new Error('Unexpected role name');
  const file = readFileSync(new URL('../../db/app-role-grants.sql', import.meta.url), 'utf8');
  const sql = file.replaceAll(':"app_role"', `"${roleName}"`);
  if (/:"[a-z_]+"/.test(sql.replace(/--.*$/gm, ''))) {
    throw new Error('app-role-grants.sql has a psql variable other than :"app_role"');
  }
  return sql;
}

/**
 * Creates (or refreshes) a NON-OWNER login role and applies apps/api/db/app-role-grants.sql to it,
 * exactly as production does. Runs as the superuser/owner that owns the tables.
 * The password is random per run and handed to the tests through the environment (worker
 * processes are spawned after global setup and inherit it); it never touches disk.
 */
async function ensureRestrictedAppRole(): Promise<void> {
  const password = randomBytes(24).toString('hex');
  const client = new pg.Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    const database = rows[0]?.db;
    if (database !== 'iorder_test') throw new Error(`Refusing to set up roles in ${database}`);

    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE_NAME]);
    // Identifiers and the password are ours (constant name, hex password), never user input.
    const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
    await client.query(
      `${verb} ROLE ${APP_ROLE_NAME} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${APP_ROLE_NAME}`);
    // Everything else comes from the production grants file: one source of truth.
    await client.query(appRoleGrantsSql(APP_ROLE_NAME));
  } finally {
    await client.end();
  }
  process.env[APP_ROLE_PASSWORD_ENV] = password;
}
