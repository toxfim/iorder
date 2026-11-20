import { Module } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AuditModule } from '../audit/index.js';
import { CatalogModule } from '../catalog/index.js';
import { PGBOSS_SCHEMA } from '../jobs/job-definitions.js';
import { PricingModule } from '../pricing/index.js';
import { DeliveryCostSource } from './delivery-cost-source.js';
import { createDeliveryCostSource } from './google/create-delivery-cost-source.js';
import {
  createSenderBoss,
  PgBossSheetSyncQueue,
  SheetSyncQueue,
  UnavailableSheetSyncQueue,
} from './sheet-sync-queue.js';
import {
  ProductCodeSelection,
  SELECTED_PRODUCT_CODES,
  SheetRowSelection,
} from './product-code-selection.js';
import { SheetSyncRunController } from './sheet-sync-run.controller.js';
import { SheetSyncRunRepository } from './sheet-sync-run.repository.js';
import { SheetSyncRunService } from './sheet-sync-run.service.js';
import { SheetsSyncService } from './sheets-sync.service.js';

@Module({
  imports: [AuditModule, CatalogModule, PricingModule],
  controllers: [SheetSyncRunController],
  providers: [
    // The real Google source only when the key file, sheet id and tab are all configured;
    // otherwise the unconfigured one, which fails loudly. Tests override it.
    {
      provide: DeliveryCostSource,
      useFactory: (env: Env): DeliveryCostSource => createDeliveryCostSource(env),
      inject: [APP_ENV],
    },
    // "Sync now" can only be queued where the worker jobs are on (same database, same role, so
    // the pg-boss grants of the worker cover the sender). Otherwise it answers a clear 409.
    {
      provide: SheetSyncQueue,
      useFactory: (env: Env): SheetSyncQueue =>
        env.JOBS_ENABLED && env.JOBS_SHEET_SYNC_ENABLED
          ? new PgBossSheetSyncQueue(createSenderBoss(env.DATABASE_URL, PGBOSS_SCHEMA))
          : new UnavailableSheetSyncQueue(),
      inject: [APP_ENV],
    },
    // Which rows are read: the owner's «Товар_ID» list (data-model §6.4). Tests pass their own.
    { provide: SheetRowSelection, useValue: new ProductCodeSelection(SELECTED_PRODUCT_CODES) },
    SheetSyncRunRepository,
    SheetSyncRunService,
    SheetsSyncService,
  ],
  exports: [SheetsSyncService, SheetSyncRunService],
})
export class SheetsSyncModule {}
