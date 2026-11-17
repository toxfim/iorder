/** Integration tests only ever use TEST_DATABASE_URL, never the dev database. */
export function getTestDatabaseUrl(): string {
  try {
    process.loadEnvFile(new URL('../../../../.env', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
  }
  return url;
}

/** Non-owner, DML-only login role created by global setup (test database only). */
export const APP_ROLE_NAME = 'iorder_app_test';
export const APP_ROLE_PASSWORD_ENV = 'IORDER_TEST_APP_ROLE_PASSWORD';

/** Connection string for the restricted role: same server and database, different login. */
export function getRestrictedRoleUrl(): string {
  const password = process.env[APP_ROLE_PASSWORD_ENV];
  if (!password) throw new Error('Restricted role password missing: global setup did not run');
  const url = new URL(getTestDatabaseUrl());
  url.username = APP_ROLE_NAME;
  url.password = password;
  return url.toString();
}
