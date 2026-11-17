import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/database/prisma.service.js';
import { getTestDatabaseUrl } from './support/test-env.js';

describe('database (real PostgreSQL)', () => {
  const prisma = new PrismaService({ DATABASE_URL: getTestDatabaseUrl() });

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('runs against the test database, not the dev one', async () => {
    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(rows[0]?.current_database).toBe('iorder_test');
  });

  it('has the app_settings table from the first migration', async () => {
    await expect(prisma.appSetting.count()).resolves.toBeTypeOf('number');
  });

  it('stores timestamps as UTC timestamptz', async () => {
    const rows = await prisma.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'app_settings' AND column_name = 'updated_at'`;
    expect(rows[0]?.data_type).toBe('timestamp with time zone');
  });
});
