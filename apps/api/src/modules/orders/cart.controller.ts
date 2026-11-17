import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  setCartItemRequestSchema,
  uuidSchema,
  type CartResponse,
  type SetCartItemRequest,
} from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, CustomerArea, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CartService } from './cart.service.js';
import { toCartResponse } from './dto/order.response.js';
import { CustomerAudienceGuard } from './order-audience.guard.js';

const productIdPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. A customer's cart belongs to their organization, a staff
// viewer's to nobody ([C] 2026-11-09); the rules and the pricing live in CartService.
@Controller('cart')
@CustomerArea()
@RequirePermission('USE_CART')
@UseGuards(CustomerAudienceGuard)
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  async get(@CurrentActor() actor: Actor): Promise<CartResponse> {
    return toCartResponse(await this.carts.getCart(actor));
  }

  @Put('items/:productId')
  async setItem(
    @CurrentActor() actor: Actor,
    @Param('productId', productIdPipe) productId: string,
    @Body(new ZodValidationPipe(setCartItemRequestSchema)) body: SetCartItemRequest,
  ): Promise<CartResponse> {
    return toCartResponse(await this.carts.setItemQuantity(actor, productId, body.quantity));
  }

  /** Removing a line that is not in the cart is not an error: the cart is returned as it is. */
  @Delete('items/:productId')
  async removeItem(
    @CurrentActor() actor: Actor,
    @Param('productId', productIdPipe) productId: string,
  ): Promise<CartResponse> {
    return toCartResponse(await this.carts.removeItem(actor, productId));
  }
}
