import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  updateUsdRateRequestSchema,
  type PriceListCostsResponse,
  type ProductCostReferenceResponse,
  type UpdateUsdRateRequest,
  type UsdRateResponse,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import {
  toPriceListCostsResponse,
  toProductCostReferenceResponse,
  toUsdRateResponse,
} from './dto/cost-reference.response.js';
import { IdentityService } from '../identity/index.js';
import { PriceReferenceService } from './price-reference.service.js';
import type { UsdRateView } from './price-reference.types.js';
import { UsdRateService } from './usd-rate/usd-rate.service.js';

// STAFF-ONLY routes (manager, admin). HTTP only: validation, actor, mapping.
@Controller()
export class CostReferenceController {
  constructor(
    private readonly costReference: PriceReferenceService,
    private readonly usdRate: UsdRateService,
    private readonly identity: IdentityService,
  ) {}

  private async rateResponse(view: UsdRateView): Promise<UsdRateResponse> {
    const names = await this.identity.findDisplayNames(view.setBy === null ? [] : [view.setBy]);
    return toUsdRateResponse(view, names);
  }

  @Get('staff/products/:id/cost-reference')
  @RequirePermission('VIEW_COST_REFERENCE')
  async productCostReference(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<ProductCostReferenceResponse> {
    const { product, deliveries } = await this.costReference.getCostReference(actor, id);
    return toProductCostReferenceResponse(product, deliveries);
  }

  /** Cost reference + stock of every product in the current published list (one call). */
  @Get('staff/price-list/current/costs')
  @RequirePermission('VIEW_COST_REFERENCE')
  async currentListCosts(@CurrentActor() actor: Actor): Promise<PriceListCostsResponse> {
    return toPriceListCostsResponse(await this.costReference.getCurrentListCosts(actor));
  }

  @Get('staff/usd-rate')
  @RequirePermission('VIEW_COST_REFERENCE')
  async getUsdRate(@CurrentActor() actor: Actor): Promise<UsdRateResponse> {
    return this.rateResponse(await this.usdRate.getUsdRate(actor));
  }

  /** Back to following the Central Bank, with one refresh right away. Manager and admin only. */
  @Post('staff/usd-rate/follow-central-bank')
  @RequirePermission('SET_USD_RATE')
  @HttpCode(200)
  async followCentralBank(@CurrentActor() actor: Actor): Promise<UsdRateResponse> {
    return this.rateResponse(await this.usdRate.followCentralBank(actor));
  }

  @Put('staff/usd-rate')
  @RequirePermission('SET_USD_RATE')
  @HttpCode(200)
  async setUsdRate(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(updateUsdRateRequestSchema)) body: UpdateUsdRateRequest,
  ): Promise<UsdRateResponse> {
    return this.rateResponse(await this.usdRate.setUsdRate(actor, new Prisma.Decimal(body.rate)));
  }
}
