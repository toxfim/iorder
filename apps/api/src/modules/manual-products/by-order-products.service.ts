import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { BrandService, CatalogService } from '../catalog/index.js';
import { OpenDemandService } from '../orders/index.js';
import { PricingService } from '../pricing/index.js';
import { buildByOrderProducts, type ByOrderProductView } from './by-order-products.js';

/**
 * The staff page "Buyurtma orqali" [C, owner 2026-11-09]: the staff-added products without a sheet
 * «Товар_ID» with how many pieces open orders wait for. Read-only. For the roles that read the
 * stock page (VIEW_COST_REFERENCE: manager, accountant, admin, purchasing manager), all of whom
 * may open every order; the orders module still applies the actor's own order scope.
 *
 * A fixed number of queries whatever the number of products and orders: the open lines with their
 * organizations (2), the products (1), the published list (2), the brands (2).
 */
@Injectable()
export class ByOrderProductsService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly brands: BrandService,
    private readonly pricing: PricingService,
    private readonly demand: OpenDemandService,
  ) {}

  async list(actor: Actor): Promise<ByOrderProductView[]> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) throw new ForbiddenError('Access denied');
    const lines = await this.demand.linesOutsidePlan(actor);
    const [products, published] = await Promise.all([
      // A removed or merged product stays listed while an order still waits for it.
      this.catalog.findByOrderProducts([...new Set(lines.map((line) => line.productId))]),
      this.pricing.currentPublishedItems(),
    ]);
    return buildByOrderProducts({
      products,
      brands: await this.brands.resolveBrands(products),
      publishedItems: published?.items ?? [],
      lines,
    });
  }
}
