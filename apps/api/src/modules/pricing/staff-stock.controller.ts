import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import {
  stockOverviewQuerySchema,
  unpricedProductsQuerySchema,
  type StockOverviewQuery,
  type StockOverviewResponse,
  type UnpricedProductsQuery,
  type UnpricedProductsResponse,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toStockOverviewResponse, toUnpricedProductsResponse } from './dto/staff-stock.response.js';
import { MegaReportService } from './mega-report/mega-report.service.js';
import { StaffStockService } from './staff-stock.service.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// STAFF-ONLY routes (manager, accountant, admin). HTTP only: validation, actor, mapping.
//
// ROUTE ORDER: `GET /staff/products/unpriced` also matches `GET /staff/products/:id` of the
// catalog controller (which would answer 400, "unpriced" is not a UUID). Nest registers routes in
// module order, so the pricing module must be imported BEFORE the catalog module in AppModule;
// a test pins this.
@Controller()
export class StaffStockController {
  constructor(
    private readonly stock: StaffStockService,
    private readonly megaReport: MegaReportService,
  ) {}

  @Get('staff/products/unpriced')
  @RequirePermission('VIEW_COST_REFERENCE')
  async unpriced(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(unpricedProductsQuerySchema)) query: UnpricedProductsQuery,
  ): Promise<UnpricedProductsResponse> {
    return toUnpricedProductsResponse(await this.stock.listUnpriced(actor, query));
  }

  @Get('staff/stock')
  @RequirePermission('VIEW_COST_REFERENCE')
  async stockOverview(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(stockOverviewQuerySchema)) query: StockOverviewQuery,
  ): Promise<StockOverviewResponse> {
    return toStockOverviewResponse(await this.stock.listStock(actor, query));
  }

  /** Every live delivery line as an .xlsx (owner request, 2026-11-10). Staff-only cost data. */
  @Get('staff/stock/mega-report')
  @RequirePermission('VIEW_COST_REFERENCE')
  @Header('Cache-Control', 'no-store')
  async downloadMegaReport(@CurrentActor() actor: Actor): Promise<StreamableFile> {
    const file = await this.megaReport.build(actor);
    return new StreamableFile(file.data, {
      type: XLSX_MIME,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.byteLength,
    });
  }
}
