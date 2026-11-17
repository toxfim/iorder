import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from '../common/clock/clock.js';
import { DatabaseModule } from '../common/database/database.module.js';
import { APP_ENV, ConfigModule } from '../config/config.module.js';
import { isSheetSourceConfigured, type Env } from '../config/env.js';
import {
  formatSyncCounts,
  SheetsSyncModule,
  SheetsSyncService,
  summarizeSyncReport,
} from '../modules/sheets-sync/index.js';

// Entry point of `pnpm --filter @iorder/api sheets:sync-once`: ONE real sync from the Google Sheet
// «Поставка» into the cost reference and stock tables of the configured database.
//
// NEVER run by an agent: it reads the real sheet (read-only scope) and WRITES to the database in
// DATABASE_URL. It therefore needs `--confirm-real-sheet` as an explicit argument:
//
//   pnpm --filter @iorder/api sheets:sync-once -- --confirm-real-sheet
//
// It prints only the sync report COUNTS, never cell contents, supplier names or cost values. The
// run is recorded in `sheet_sync_runs` (trigger MANUAL) like any other.
@Module({ imports: [ConfigModule, ClockModule, DatabaseModule, SheetsSyncModule] })
class SheetsSyncOnceModule {}

async function main(): Promise<number> {
  if (!process.argv.slice(2).includes('--confirm-real-sheet')) {
    console.error(
      'sheets:sync-once reads the REAL Google Sheet and writes to the configured database. ' +
        'Add --confirm-real-sheet to proceed.',
    );
    return 1;
  }
  const app = await NestFactory.createApplicationContext(SheetsSyncOnceModule, {
    logger: ['error', 'warn'],
  });
  try {
    if (!isSheetSourceConfigured(app.get<Env>(APP_ENV))) {
      console.error(
        'The sheet source is not configured: set GOOGLE_SERVICE_ACCOUNT_FILE, GOOGLE_SHEET_ID and ' +
          'GOOGLE_SHEET_SUPPLIES_TAB.',
      );
      return 1;
    }
    const report = await app.get(SheetsSyncService).syncCostReference('MANUAL');
    console.log(`sync finished: ${formatSyncCounts(summarizeSyncReport(report))}`);
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only the error's stable code: its message could in principle carry data from the sheet.
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    console.error(`sheets:sync-once failed${code === '' ? '' : ` (${code})`}`);
    process.exitCode = 1;
  },
);
