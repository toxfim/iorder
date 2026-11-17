import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  decideProductSuccessionRequestSchema,
  productSuccessionListQuerySchema,
  type DecideProductSuccessionRequest,
  type FindProductSuccessionsResponse,
  type ProductSuccession,
  type ProductSuccessionListQuery,
  type ProductSuccessionListResponse,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { PricingService } from '../pricing/index.js';
import {
  toProductSuccession,
  toProductSuccessionListResponse,
} from './dto/product-succession.response.js';
import { ProductSuccessionsService } from './product-successions.service.js';
import type { SuccessionRow } from './recommendations.repository.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. Rules live in ProductSuccessionsService.
@Controller('staff/product-successions')
export class ProductSuccessionsController {
  constructor(
    private readonly successions: ProductSuccessionsService,
    private readonly identity: IdentityService,
    private readonly catalog: CatalogService,
    private readonly pricing: PricingService,
  ) {}

  @Get()
  @RequirePermission('VIEW_PRICE_ADMIN')
  @Header('Cache-Control', 'no-store')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(productSuccessionListQuerySchema))
    query: ProductSuccessionListQuery,
  ): Promise<ProductSuccessionListResponse> {
    const view = await this.successions.list(actor, query.status);
    const names = await this.identity.findDisplayNames(
      view.rows.flatMap((row) => (row.decidedBy === null ? [] : [row.decidedBy])),
    );
    return toProductSuccessionListResponse(view, names);
  }

  @Post('find')
  @RequirePermission('DECIDE_PRODUCT_SUCCESSION')
  @HttpCode(200)
  async find(@CurrentActor() actor: Actor): Promise<FindProductSuccessionsResponse> {
    return { proposedCount: await this.successions.findProposals(actor) };
  }

  @Post(':id/decision')
  @RequirePermission('DECIDE_PRODUCT_SUCCESSION')
  @HttpCode(200)
  async decide(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(decideProductSuccessionRequestSchema))
    body: DecideProductSuccessionRequest,
  ): Promise<ProductSuccession> {
    const row = await this.successions.decide(actor, id, body.decision);
    return this.toResponse(row);
  }

  private async toResponse(row: SuccessionRow): Promise<ProductSuccession> {
    const [products, { published }, names] = await Promise.all([
      this.catalog.findProductsByIds([row.olderProductId, row.newerProductId]),
      this.pricing.getPricedProductSets(),
      this.identity.findDisplayNames(row.decidedBy === null ? [] : [row.decidedBy]),
    ]);
    return toProductSuccession(row, new Map(products.map((p) => [p.id, p])), published, names);
  }
}
