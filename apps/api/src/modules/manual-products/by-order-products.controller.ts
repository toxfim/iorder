import { Controller, Get } from '@nestjs/common';
import type { ByOrderProductsResponse } from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ByOrderProductsService } from './by-order-products.service.js';
import { toByOrderProductsResponse } from './dto/by-order-products.response.js';

// HTTP only: actor and mapping. STAFF-ONLY, the roles of the stock page. Its own prefix: under
// `staff/products` the catalog route with an id parameter would read `by-order` as a product id.
@Controller('staff/by-order-products')
@RequirePermission('VIEW_COST_REFERENCE')
export class ByOrderProductsController {
  constructor(private readonly products: ByOrderProductsService) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<ByOrderProductsResponse> {
    return toByOrderProductsResponse(await this.products.list(actor));
  }
}
