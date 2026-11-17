import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/index.js';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { OrdersModule } from '../orders/index.js';
import { PricingModule } from '../pricing/index.js';
import { ByOrderProductsController } from './by-order-products.controller.js';
import { ByOrderProductsService } from './by-order-products.service.js';
import { ManualProductService } from './manual-product.service.js';
import { ManualProductsController } from './manual-products.controller.js';
import { PriceImportController } from './price-import/price-import.controller.js';
import { PriceImportService } from './price-import/price-import.service.js';

/**
 * Staff-added products without a sheet «Товар_ID» [C, 2026-11-09]: one product at a time, the
 * merge into a sheet product, the Excel import, and the staff page of these products with what open
 * orders wait for ("Buyurtma orqali"). It spans the catalog (the product), pricing
 * (the publish) and orders (open cart lines of a merged product), so it sits above all three and
 * uses only their exported services.
 */
@Module({
  imports: [AuditModule, CatalogModule, PricingModule, OrdersModule, IdentityModule],
  controllers: [ManualProductsController, PriceImportController, ByOrderProductsController],
  providers: [ManualProductService, PriceImportService, ByOrderProductsService],
})
export class ManualProductsModule {}
