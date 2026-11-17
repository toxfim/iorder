import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  customerOrderListQuerySchema,
  changeOwnPaymentPlanRequestSchema,
  customerReceiveOrderRequestSchema,
  submitOrderRequestSchema,
  uuidSchema,
  type ChangeOwnPaymentPlanRequest,
  type CustomerOrder,
  type CustomerOrderListQuery,
  type CustomerOrderListResponse,
  type CustomerReceiveOrderRequest,
  type CustomerTimelineResponse,
  type SubmitOrderRequest,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, CustomerArea, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toCustomerOrder, toCustomerOrderList } from './dto/order.response.js';
import { toCustomerTimeline } from './dto/timeline.response.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { CustomerAudienceGuard } from './order-audience.guard.js';
import { OrderDirectoryService } from './order-directory.service.js';
import { OrderTimelineService } from './order-timeline.service.js';
import type { OrderView } from './order.views.js';
import { OrdersService } from './orders.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. Customer area: members of an organization see ONLY
// their own organization's orders (the service scopes every query and answers 404, never 403, for
// an order they may not see). Staff use the /staff/orders routes; a staff member who comes here is
// the staff viewer ([C] 2026-11-09), who has no organization and so reads nothing of anyone's.
@Controller('orders')
@CustomerArea()
@UseGuards(CustomerAudienceGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly timeline: OrderTimelineService,
    private readonly directory: OrderDirectoryService,
  ) {}

  /** The same key twice returns the same order (also 201): the client cannot tell a retry apart. */
  @Post()
  @HttpCode(201)
  @RequirePermission('SUBMIT_ORDER')
  async submit(
    @CurrentActor() actor: Actor,
    @IdempotencyKey() key: string,
    @Body(new ZodValidationPipe(submitOrderRequestSchema)) body: SubmitOrderRequest,
  ): Promise<CustomerOrder> {
    return this.present(actor, await this.orders.submitOwnCart(actor, key, body));
  }

  @Get()
  @RequirePermission('VIEW_ORDER')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(customerOrderListQuerySchema)) query: CustomerOrderListQuery,
  ): Promise<CustomerOrderListResponse> {
    const page = await this.orders.listOrdersFor(actor, query);
    return toCustomerOrderList(page, actor, await this.directory.load(actor, page.orders));
  }

  @Get(':id')
  @RequirePermission('VIEW_ORDER')
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string): Promise<CustomerOrder> {
    return this.present(actor, await this.orders.getOrderFor(actor, id));
  }

  @Get(':id/timeline')
  @RequirePermission('VIEW_ORDER')
  async getTimeline(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
  ): Promise<CustomerTimelineResponse> {
    return toCustomerTimeline(await this.timeline.getTimeline(actor, id));
  }

  @Post(':id/receive')
  @HttpCode(200)
  @RequirePermission('CONFIRM_RECEIPT')
  async receive(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(customerReceiveOrderRequestSchema))
    body: CustomerReceiveOrderRequest,
  ): Promise<CustomerOrder> {
    return this.present(
      actor,
      await this.orders.transition(actor, id, {
        to: 'RECEIVED',
        reason: body.comment,
        expectedRowVersion: body.expectedRowVersion,
      }),
    );
  }

  @Put(':id/payment-plan')
  @RequirePermission('CHANGE_OWN_PAYMENT_PLAN')
  async changePaymentPlan(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(changeOwnPaymentPlanRequestSchema))
    body: ChangeOwnPaymentPlanRequest,
  ): Promise<CustomerOrder> {
    return this.present(actor, await this.orders.changeOwnPaymentPlan(actor, id, body));
  }

  private async present(actor: Actor, view: OrderView): Promise<CustomerOrder> {
    return toCustomerOrder(
      view,
      actor,
      await this.directory.load(actor, [view]),
      this.orders.paymentPlanChangeOfferFor(actor, view),
    );
  }
}
