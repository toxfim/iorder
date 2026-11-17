import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/index.js';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { OrganizationsModule } from '../organizations/index.js';
import { CostReferenceController } from './cost-reference.controller.js';
import { PriceReferenceRepository } from './price-reference.repository.js';
import { PriceReferenceService } from './price-reference.service.js';
import { PricingController } from './pricing.controller.js';
import { StaffStockController } from './staff-stock.controller.js';
import { StaffStockService } from './staff-stock.service.js';
import { SupplyPartyController } from './supply-party/supply-party.controller.js';
import { SupplyPartyRepository } from './supply-party/supply-party.repository.js';
import { SupplyPartyService } from './supply-party/supply-party.service.js';
import { SupplyRemovalController } from './supply-removal/supply-removal.controller.js';
import { SupplyRemovalRepository } from './supply-removal/supply-removal.repository.js';
import { SupplyRemovalService } from './supply-removal/supply-removal.service.js';
import { SupplyAllocationRepository } from './supply-allocation/supply-allocation.repository.js';
import { SupplyAllocationService } from './supply-allocation/supply-allocation.service.js';
import {
  BankUzUsdRateProvider,
  FallbackUsdRateProvider,
} from './usd-rate/bank-uz-usd-rate-provider.js';
import { CbuUsdRateProvider } from './usd-rate/cbu-usd-rate-provider.js';
import { RateRefreshService } from './usd-rate/rate-refresh.service.js';
import { UsdRateRepository } from './usd-rate/usd-rate.repository.js';
import { UsdRateService } from './usd-rate/usd-rate.service.js';
import { UsdRateProvider } from './usd-rate/usd-rate-provider.js';
import {
  TelegramChannelRateProvider,
  UsdChannelRateProvider,
} from './usd-rate/usd-channel-rate-provider.js';
import { PriceListExportService } from './price-list-export.service.js';
import { PriceListFileController } from './price-list-file.controller.js';
import { PriceListPostService } from './price-list-post.service.js';
import { PricingRepository } from './pricing.repository.js';
import { PricingService } from './pricing.service.js';
import { MegaReportService } from './mega-report/mega-report.service.js';

@Module({
  imports: [AuditModule, CatalogModule, IdentityModule, OrganizationsModule],
  controllers: [
    PricingController,
    CostReferenceController,
    StaffStockController,
    SupplyRemovalController,
    SupplyPartyController,
    PriceListFileController,
  ],
  providers: [
    PricingRepository,
    PricingService,
    PriceListExportService,
    PriceListPostService,
    MegaReportService,
    PriceReferenceRepository,
    PriceReferenceService,
    StaffStockService,
    UsdRateRepository,
    UsdRateService,
    RateRefreshService,
    SupplyRemovalRepository,
    SupplyRemovalService,
    SupplyAllocationRepository,
    SupplyAllocationService,
    SupplyPartyRepository,
    SupplyPartyService,
    // The real bank client over the built-in fetch. Nothing calls it automatically; tests replace it.
    {
      provide: UsdRateProvider,
      useFactory: (): UsdRateProvider => {
        const fetchImpl = globalThis.fetch.bind(globalThis);
        return new FallbackUsdRateProvider(
          new CbuUsdRateProvider(fetchImpl),
          new BankUzUsdRateProvider(fetchImpl),
        );
      },
    },
    {
      provide: UsdChannelRateProvider,
      useFactory: (): UsdChannelRateProvider =>
        new TelegramChannelRateProvider(globalThis.fetch.bind(globalThis)),
    },
  ],
  exports: [
    PricingService,
    PriceListExportService,
    PriceListPostService,
    PriceReferenceService,
    StaffStockService,
    UsdRateService,
    RateRefreshService,
    SupplyRemovalService,
    SupplyAllocationService,
    SupplyPartyService,
  ],
})
export class PricingModule {}
