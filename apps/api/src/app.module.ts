import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PermissionGuard } from './common/auth/permission.guard.js';
import { ClockModule } from './common/clock/clock.js';
import { DatabaseModule } from './common/database/database.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { IdentityModule } from './modules/identity/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { OrganizationsModule } from './modules/organizations/index.js';
import { TelegramModule } from './modules/telegram/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { DashboardModule } from './modules/dashboard/index.js';
import { ManualProductsModule } from './modules/manual-products/index.js';
import { OrdersModule } from './modules/orders/index.js';
import { PricingModule } from './modules/pricing/index.js';
import { RecommendationsModule } from './modules/recommendations/index.js';
import { SheetsSyncModule } from './modules/sheets-sync/index.js';
import { ConfigModule } from './config/config.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule,
    ClockModule,
    DatabaseModule,
    // ORDER MATTERS: PricingModule first, so `GET /staff/products/unpriced` is registered before
    // the catalog's `GET /staff/products/:id` (see StaffStockController). A test pins it.
    PricingModule,
    CatalogModule,
    SheetsSyncModule,
    IdentityModule,
    OrganizationsModule,
    // The bot is inert unless TELEGRAM_MODE says otherwise; see modules/telegram.
    TelegramModule,
    NotificationsModule,
    // Last: its routes (/cart, /orders, /staff/orders) overlap no route above, and its own
    // imports (pricing, catalog) are already registered in the order the constraint needs.
    OrdersModule,
    DashboardModule,
    // After orders (it moves cart lines on a merge). Its routes are fixed segments under
    // staff/products and staff/price-list/import, so they never shadow a `:id` route above.
    ManualProductsModule,
    // Customer home recommendations and the newer-model pairs: fixed segments under /me and
    // /staff/product-successions, overlapping nothing above.
    RecommendationsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global so a route without a declared policy is denied, not open.
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}
