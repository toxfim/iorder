import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/index.js';
import { CatalogModule } from '../catalog/index.js';
import { IdentityModule } from '../identity/index.js';
import { OrganizationsModule } from '../organizations/index.js';
import { PricingModule } from '../pricing/index.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { MarkedOrderNotificationsService } from './marked-order-notifications.service.js';
import { OpenDemandService } from './open-demand.service.js';
import { OrderDirectoryService } from './order-directory.service.js';
import { OrderItemAllocationsService } from './order-item-allocations.service.js';
import { OrderStatsService } from './order-stats.service.js';
import { OrderTimelineService } from './order-timeline.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';
import { OrderUnitsRepository } from './order-units.repository.js';
import { CustomerGoodsController } from './customer-goods.controller.js';
import { CustomerGoodsRepository } from './customer-goods.repository.js';
import { CustomerGoodsService } from './customer-goods.service.js';
import { PickingController } from './picking.controller.js';
import { PickingService } from './picking.service.js';
import { StaffNewOrderService } from './staff-new-order.service.js';
import { StaffOrderListService } from './staff-order-list.service.js';
import { StaffOrdersController } from './staff-orders.controller.js';
import {
  CustomerBalanceController,
  StaffOrganizationPaymentsController,
} from './organization-payments.controller.js';
import { OrganizationPaymentsRepository } from './organization-payments.repository.js';
import { OrganizationPaymentsService } from './organization-payments.service.js';

@Module({
  imports: [AuditModule, CatalogModule, IdentityModule, OrganizationsModule, PricingModule],
  controllers: [
    CartController,
    OrdersController,
    StaffOrdersController,
    PickingController,
    CustomerGoodsController,
    StaffOrganizationPaymentsController,
    CustomerBalanceController,
  ],
  providers: [
    OrdersRepository,
    OrderUnitsRepository,
    PickingService,
    CustomerGoodsRepository,
    CustomerGoodsService,
    CartService,
    OrdersService,
    OrderItemAllocationsService,
    OrderDirectoryService,
    MarkedOrderNotificationsService,
    OrderStatsService,
    OpenDemandService,
    OrderTimelineService,
    StaffOrderListService,
    StaffNewOrderService,
    OrganizationPaymentsRepository,
    OrganizationPaymentsService,
  ],
  exports: [OrdersService, CartService, OrderStatsService, OrderTimelineService, OpenDemandService],
})
export class OrdersModule {}
