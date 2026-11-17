import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/index.js';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { OrdersModule } from '../orders/index.js';
import { PricingModule } from '../pricing/index.js';
import { CustomerRecommendationsController } from './customer-recommendations.controller.js';
import { CustomerRecommendationsService } from './customer-recommendations.service.js';
import { ProductSuccessionsController } from './product-successions.controller.js';
import { ProductSuccessionsService } from './product-successions.service.js';
import { RecommendationsRepository } from './recommendations.repository.js';

/**
 * The customer home recommendations ([C] 2026-11-09) and the staff-decided "newer model" pairs
 * they draw on. Reads orders through its own set-based queries over the organization's received
 * orders; products, prices and photos come from the catalog and pricing services.
 */
@Module({
  imports: [AuditModule, CatalogModule, IdentityModule, OrdersModule, PricingModule],
  controllers: [CustomerRecommendationsController, ProductSuccessionsController],
  providers: [RecommendationsRepository, CustomerRecommendationsService, ProductSuccessionsService],
  exports: [CustomerRecommendationsService, ProductSuccessionsService],
})
export class RecommendationsModule {}
