import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/index.js';
import { OrganizationsModule } from '../organizations/index.js';
import { PricingModule } from '../pricing/index.js';
import { SheetsSyncModule } from '../sheets-sync/index.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [OrdersModule, OrganizationsModule, PricingModule, SheetsSyncModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
