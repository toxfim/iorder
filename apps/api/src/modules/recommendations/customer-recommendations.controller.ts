import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import type { CustomerHomeRecommendationsResponse } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, CustomerArea, RequirePermission } from '../../common/auth/route-access.js';
import { CatalogService } from '../catalog/index.js';
import { CustomerAudienceGuard } from '../orders/index.js';
import { PricingService } from '../pricing/index.js';
import { CustomerRecommendationsService } from './customer-recommendations.service.js';
import { toCustomerHomeRecommendationsResponse } from './dto/customer-home.response.js';

// HTTP only. The home recommendations of the caller's own organization; the service scopes every
// query by the authenticated membership and a staff viewer gets empty blocks.
@Controller('me/recommendations')
@CustomerArea()
@UseGuards(CustomerAudienceGuard)
@RequirePermission('VIEW_OWN_RECOMMENDATIONS')
export class CustomerRecommendationsController {
  constructor(
    private readonly recommendations: CustomerRecommendationsService,
    private readonly pricing: PricingService,
    private readonly catalog: CatalogService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async home(@CurrentActor() actor: Actor): Promise<CustomerHomeRecommendationsResponse> {
    const view = await this.recommendations.forHome(actor);
    // Photos and the stock figure of the recommended products only (two queries, not per card).
    const shown = [
      ...view.reorder.map((row) => row.product),
      ...view.matching.map((row) => row.product),
      ...(view.newerModel === null ? [] : [view.newerModel.product]),
    ].map((item) => item.product);
    const [images, orderableStock] = await Promise.all([
      this.catalog.primaryImageIds(shown.map((product) => product.id)),
      this.pricing.getOrderableStock(shown),
    ]);
    return toCustomerHomeRecommendationsResponse(view, images, orderableStock);
  }
}
