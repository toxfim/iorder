import type { MarkedOrderNotificationListResponse } from '@iorder/shared/staff-auth';
import { MarkedOrderNotificationsService } from './marked-order-notifications.service.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  type AllocationPreview,
  type SetOrderAllocationsRequest,
  approveOrderRequestSchema,
  editOrderItemsRequestSchema,
  orderDecisionWithCommentRequestSchema,
  orderDecisionWithReasonRequestSchema,
  releaseOrderRequestSchema,
  setPaymentMethodRequestSchema,
  setOrderAllocationsRequestSchema,
  setPaymentPlanRequestSchema,
  staffOrderCountsQuerySchema,
  staffOrderListQuerySchema,
  type ApproveOrderRequest,
  type EditOrderItemsRequest,
  type OrderDecisionWithCommentRequest,
  type OrderDecisionWithReasonRequest,
  type ReleaseOrderRequest,
  type SetPaymentMethodRequest,
  type SetPaymentPlanRequest,
  type StaffOrder,
  type StaffOrderCountsQuery,
  type StaffOrderCountsResponse,
  type StaffOrderListQuery,
  type StaffOrderListResponse,
  type StaffTimelineResponse,
} from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toStaffOrder, toStaffOrderList } from './dto/order.response.js';
import { toStaffTimeline } from './dto/timeline.response.js';
import { StaffAudienceGuard } from './order-audience.guard.js';
import { OrderDirectoryService } from './order-directory.service.js';
import { OrderItemAllocationsService } from './order-item-allocations.service.js';
import { OrderTimelineService } from './order-timeline.service.js';
import type { OrderView } from './order.views.js';
import type { TransitionCommand } from './orders.schemas.js';
import { OrdersService } from './orders.service.js';
import { StaffOrderListService } from './staff-order-list.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. Each route names the matrix action as a COARSE gate
// (can this person ever do this?); OrdersService decides with the order's facts (can they do it
// to THIS order now?) and answers 404 for an order they may not see, 409 for a stale row version.
// Every decision carries the row version the person saw (`expectedRowVersion`, required).
@Controller('staff/orders')
@UseGuards(StaffAudienceGuard)
export class StaffOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly timeline: OrderTimelineService,
    private readonly directory: OrderDirectoryService,
    private readonly list: StaffOrderListService,
    private readonly allocations: OrderItemAllocationsService,
    private readonly markedNotifications: MarkedOrderNotificationsService,
  ) {}

  // Declared before `:id`, which would otherwise take this path as an order id.
  @Get('marked-notifications')
  @RequirePermission('VIEW_MARKED_ORDER_NOTIFICATIONS')
  async listMarkedNotifications(
    @CurrentActor() actor: Actor,
  ): Promise<MarkedOrderNotificationListResponse> {
    return { items: await this.markedNotifications.list(actor) };
  }

  @Get()
  @RequirePermission('VIEW_ORDER')
  async listOrders(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(staffOrderListQuerySchema)) query: StaffOrderListQuery,
  ): Promise<StaffOrderListResponse> {
    const page = await this.list.list(actor, query);
    return toStaffOrderList(page, await this.directory.load(actor, page.orders));
  }

  // Declared before `:id`, which would otherwise take "counts" as an order id.
  @Get('counts')
  @RequirePermission('VIEW_ORDER')
  async countOrders(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(staffOrderCountsQuerySchema)) query: StaffOrderCountsQuery,
  ): Promise<StaffOrderCountsResponse> {
    return this.list.counts(actor, query);
  }

  @Get(':id')
  @RequirePermission('VIEW_ORDER')
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string): Promise<StaffOrder> {
    return this.present(actor, await this.orders.getOrderFor(actor, id));
  }

  @Get(':id/timeline')
  @RequirePermission('VIEW_ORDER')
  async getTimeline(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<StaffTimelineResponse> {
    return toStaffTimeline(await this.timeline.getTimeline(actor, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('MANAGER_DECIDE_ORDER')
  async approve(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(approveOrderRequestSchema)) body: ApproveOrderRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, {
      to: 'MANAGER_APPROVED',
      reason: body.comment,
      skipAccounting: body.skipAccounting,
      paymentMethod: body.paymentMethod,
      allocationMode: body.allocationMode,
      allocations: body.allocations,
      expectedRowVersion: body.expectedRowVersion,
    });
  }

  @Get(':id/allocation-preview')
  @RequirePermission('MANAGE_ORDER_ALLOCATION')
  async allocationPreview(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<AllocationPreview> {
    return this.orders.allocationPreview(actor, id);
  }

  @Post(':id/allocations')
  @HttpCode(200)
  @RequirePermission('MANAGE_ORDER_ALLOCATION')
  async setAllocations(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(setOrderAllocationsRequestSchema)) body: SetOrderAllocationsRequest,
  ): Promise<AllocationPreview> {
    return this.orders.setAllocations(actor, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('MANAGER_DECIDE_ORDER')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(orderDecisionWithReasonRequestSchema))
    body: OrderDecisionWithReasonRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, { to: 'REJECTED', ...body });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('CANCEL_ORDER')
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(orderDecisionWithReasonRequestSchema))
    body: OrderDecisionWithReasonRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, { to: 'CANCELLED', ...body });
  }

  @Post(':id/accounting-approve')
  @HttpCode(200)
  @RequirePermission('ACCOUNTING_DECIDE_ORDER')
  async accountingApprove(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(orderDecisionWithCommentRequestSchema))
    body: OrderDecisionWithCommentRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, {
      to: 'ACCOUNTING_CLEARED',
      reason: body.comment,
      expectedRowVersion: body.expectedRowVersion,
    });
  }

  @Post(':id/accounting-reject')
  @HttpCode(200)
  @RequirePermission('ACCOUNTING_DECIDE_ORDER')
  async accountingReject(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(orderDecisionWithReasonRequestSchema))
    body: OrderDecisionWithReasonRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, { to: 'REJECTED', ...body });
  }

  @Post(':id/release')
  @HttpCode(200)
  @RequirePermission('RELEASE_ORDER')
  async release(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(releaseOrderRequestSchema)) body: ReleaseOrderRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, {
      to: 'RELEASED',
      driverUserId: body.driverUserId,
      reason: body.comment,
      expectedRowVersion: body.expectedRowVersion,
    });
  }

  @Post(':id/deliver')
  @HttpCode(200)
  @RequirePermission('MARK_DELIVERED')
  async deliver(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(orderDecisionWithCommentRequestSchema))
    body: OrderDecisionWithCommentRequest,
  ): Promise<StaffOrder> {
    return this.move(actor, id, {
      to: 'DELIVERED',
      reason: body.comment,
      expectedRowVersion: body.expectedRowVersion,
    });
  }

  @Post(':id/goods-returned')
  @HttpCode(200)
  @RequirePermission('MARK_GOODS_RETURNED')
  async goodsReturned(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(orderDecisionWithCommentRequestSchema))
    body: OrderDecisionWithCommentRequest,
  ): Promise<StaffOrder> {
    return this.present(actor, await this.orders.markGoodsReturned(actor, id, body));
  }

  @Patch(':id/items')
  @RequirePermission('EDIT_ORDER_ITEMS')
  async editItems(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(editOrderItemsRequestSchema)) body: EditOrderItemsRequest,
  ): Promise<StaffOrder> {
    return this.present(actor, await this.orders.editItems(actor, id, body));
  }

  @Put(':id/payment-method')
  @RequirePermission('SET_PAYMENT_METHOD')
  async setPaymentMethod(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(setPaymentMethodRequestSchema)) body: SetPaymentMethodRequest,
  ): Promise<StaffOrder> {
    return this.present(actor, await this.orders.setPaymentMethod(actor, id, body));
  }

  @Put(':id/payment-plan')
  @RequirePermission('SET_PAYMENT_PLAN')
  async setPaymentPlan(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(setPaymentPlanRequestSchema)) body: SetPaymentPlanRequest,
  ): Promise<StaffOrder> {
    return this.present(actor, await this.orders.setPaymentPlan(actor, id, body));
  }

  private async move(actor: Actor, id: string, command: TransitionCommand): Promise<StaffOrder> {
    return this.present(actor, await this.orders.transition(actor, id, command));
  }

  private async present(actor: Actor, view: OrderView): Promise<StaffOrder> {
    // Who sees the unit codes sees the supplies: everyone with the order but the driver.
    const allocations = can(actor, 'VIEW_UNIT_CODES')
      ? await this.allocations.ofOrder(view.id)
      : null;
    return toStaffOrder(
      view,
      await this.directory.load(actor, [view], { withContacts: true }),
      allocations,
    );
  }
}
