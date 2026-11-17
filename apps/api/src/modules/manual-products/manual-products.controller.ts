import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  createManualProductRequestSchema,
  manualProductCheckQuerySchema,
  mergePreviewQuerySchema,
  mergeProductRequestSchema,
  type CreateManualProductResponse,
  type ManualProductCheckQuery,
  type ManualProductCheckResponse,
  type MergePreviewQuery,
  type MergePreviewResponse,
  type MergeProductRequest,
  type MergeProductResponse,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { Prisma } from '../../generated/prisma/client.js';
import { IdentityService } from '../identity/index.js';
import { PricingService, toPublishChangesWithRate, type VersionView } from '../pricing/index.js';
import {
  toManualProductCheckResponse,
  toMergePreviewResponse,
} from './dto/manual-products.response.js';
import { ManualProductService } from './manual-product.service.js';

/** The shared request plus the api-side step to Decimal, so no float exists after the boundary. */
const createManualProductSchema = createManualProductRequestSchema.transform((request) => ({
  baseVersionNumber: request.baseVersionNumber,
  name: request.name,
  brandId: request.brandId,
  category: request.category,
  basePrice: new Prisma.Decimal(request.basePrice),
  deferredPrice: request.deferredPrice === null ? null : new Prisma.Decimal(request.deferredPrice),
}));
type CreateManualProductInput = ReturnType<(typeof createManualProductSchema)['parse']>;

// HTTP only: validation, actor, mapping. Rules live in ManualProductService. Under staff/products
// like the catalog's routes; `manual` is a fixed segment, so it never reads as a product id, and
// `manual/check` has two segments, so no `:id` route of this prefix can swallow it (asserted in
// contract-routes.spec.ts).
@Controller('staff/products')
@RequirePermission('UPDATE_PRICE_LIST')
export class ManualProductsController {
  constructor(
    private readonly products: ManualProductService,
    private readonly pricing: PricingService,
    private readonly identity: IdentityService,
  ) {}

  @Get('manual/check')
  async check(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(manualProductCheckQuerySchema)) query: ManualProductCheckQuery,
  ): Promise<ManualProductCheckResponse> {
    return toManualProductCheckResponse(await this.products.check(actor, query.name));
  }

  @Post('manual')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createManualProductSchema)) body: CreateManualProductInput,
  ): Promise<CreateManualProductResponse> {
    const created = await this.products.create(actor, body);
    return {
      productId: created.productId,
      productCode: created.productCode,
      version: await this.versionDto(actor, created.version, created.skippedInactiveCount),
    };
  }

  @Get(':id/merge-preview')
  async mergePreview(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(mergePreviewQuerySchema)) query: MergePreviewQuery,
  ): Promise<MergePreviewResponse> {
    return toMergePreviewResponse(
      await this.products.mergePreview(actor, id, query.targetProductId),
    );
  }

  @Post(':id/merge')
  @HttpCode(200)
  async merge(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(mergeProductRequestSchema)) body: MergeProductRequest,
  ): Promise<MergeProductResponse> {
    const result = await this.products.merge(
      actor,
      id,
      body.targetProductId,
      body.baseVersionNumber,
    );
    return {
      sourceProductId: result.sourceProductId,
      targetProductId: result.targetProductId,
      version:
        result.version === null
          ? null
          : await this.versionDto(
              actor,
              result.version.version,
              result.version.skippedInactiveCount,
            ),
    };
  }

  /** The same DTO as POST /staff/price-list/publish answers (rate snapshot, publisher name). */
  private async versionDto(
    actor: Actor,
    version: VersionView,
    skippedInactiveCount: number,
  ): Promise<CreateManualProductResponse['version']> {
    const [snapshots, names] = await Promise.all([
      this.pricing.getRateSnapshots(actor, [version.id]),
      this.identity.findDisplayNames(version.publishedBy === null ? [] : [version.publishedBy]),
    ]);
    return toPublishChangesWithRate(version, skippedInactiveCount, snapshots, names);
  }
}
