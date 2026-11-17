import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  sheetSyncRunsQuerySchema,
  type SheetSyncRequestResponse,
  type SheetSyncRun,
  type SheetSyncRunsQuery,
  type SheetSyncRunsResponse,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { SheetSyncRunService } from './sheet-sync-run.service.js';

// STAFF-ONLY. Reading the reports: manager, accountant, admin. "Sync now": manager, admin.
@Controller('staff/sheet-sync/runs')
export class SheetSyncRunController {
  constructor(private readonly runs: SheetSyncRunService) {}

  /**
   * "Sync now": queues one run for the worker and answers at once (202); the result shows up as
   * a new run in the history. 409 SHEET_SYNC_QUEUE_UNAVAILABLE when the worker jobs are off.
   */
  @Post()
  @HttpCode(202)
  @RequirePermission('RUN_SHEET_SYNC')
  request(@CurrentActor() actor: Actor): Promise<SheetSyncRequestResponse> {
    return this.runs.request(actor);
  }

  @Get()
  @RequirePermission('VIEW_COST_REFERENCE')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(sheetSyncRunsQuerySchema)) query: SheetSyncRunsQuery,
  ): Promise<SheetSyncRunsResponse> {
    return { items: await this.runs.list(actor, query.limit) };
  }

  /** The newest run, or 404 NOT_FOUND when the sync never ran. */
  @Get('last')
  @RequirePermission('VIEW_COST_REFERENCE')
  last(@CurrentActor() actor: Actor): Promise<SheetSyncRun> {
    return this.runs.last(actor);
  }
}
