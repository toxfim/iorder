import { Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  customerGoodsQuerySchema,
  type CustomerGoodsList,
  type CustomerGoodsProduct,
  type CustomerGoodsQuery,
  type CustomerGoodsSummary,
  type CustomerGoodsUnit,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, CustomerArea, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CustomerGoodsService } from './customer-goods.service.js';
import {
  toCustomerGoodsList,
  toCustomerGoodsProduct,
  toCustomerGoodsSummary,
  toCustomerGoodsUnit,
} from './dto/customer-goods.response.js';
import { CustomerAudienceGuard } from './order-audience.guard.js';

const queryPipe = new ZodValidationPipe(customerGoodsQuerySchema);

// HTTP only. My Products of the caller's own organization; ids that are not UUIDs or not the
// organization's answer the same 404 (the service checks).
@Controller('me/products')
@CustomerArea()
@UseGuards(CustomerAudienceGuard)
@RequirePermission('VIEW_RECEIVED_GOODS')
export class CustomerGoodsController {
  constructor(private readonly goods: CustomerGoodsService) {}

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  async summary(@CurrentActor() actor: Actor): Promise<CustomerGoodsSummary> {
    return toCustomerGoodsSummary(await this.goods.summary(actor));
  }

  @Post('discovery/ack')
  @HttpCode(204)
  async acknowledgeDiscovery(@CurrentActor() actor: Actor): Promise<void> {
    await this.goods.acknowledgeDiscovery(actor);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @CurrentActor() actor: Actor,
    @Query(queryPipe) query: CustomerGoodsQuery,
  ): Promise<CustomerGoodsList> {
    return toCustomerGoodsList(await this.goods.list(actor, query));
  }

  @Get(':productId')
  @Header('Cache-Control', 'no-store')
  async product(
    @CurrentActor() actor: Actor,
    @Param('productId') productId: string,
    @Query(queryPipe) query: CustomerGoodsQuery,
  ): Promise<CustomerGoodsProduct> {
    return toCustomerGoodsProduct(await this.goods.product(actor, productId, query));
  }

  @Get(':productId/units/:unitId')
  @Header('Cache-Control', 'no-store')
  async unit(
    @CurrentActor() actor: Actor,
    @Param('productId') productId: string,
    @Param('unitId') unitId: string,
  ): Promise<CustomerGoodsUnit> {
    return toCustomerGoodsUnit(await this.goods.unit(actor, productId, unitId));
  }
}
