import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  createBrandRequestSchema,
  setProductBrandRequestSchema,
  type BrandListResponse,
  type BrandResponse,
  type CreateBrandRequest,
  type ProductBrandResponse,
  type SetProductBrandRequest,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { BrandService } from './brand.service.js';
import type { BrandView } from './product.view.js';

const toBrandResponse = (brand: BrandView): BrandResponse => ({ id: brand.id, name: brand.name });

// HTTP only: validation, actor, mapping. Rules live in BrandService. The unbranded product list
// is served by the pricing module (it needs the published price list for "priced").
@Controller()
@RequirePermission('UPDATE_PRICE_LIST')
export class BrandController {
  constructor(private readonly brands: BrandService) {}

  @Get('staff/brands')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async list(@CurrentActor() actor: Actor): Promise<BrandListResponse> {
    return { items: (await this.brands.listBrands(actor)).map(toBrandResponse) };
  }

  @Post('staff/brands')
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createBrandRequestSchema)) body: CreateBrandRequest,
  ): Promise<BrandResponse> {
    return toBrandResponse(await this.brands.createBrand(actor, body.name));
  }

  @Put('staff/products/:id/brand')
  @HttpCode(200)
  async setProductBrand(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(setProductBrandRequestSchema)) body: SetProductBrandRequest,
  ): Promise<ProductBrandResponse> {
    const result = await this.brands.setProductBrand(actor, id, body.brandId);
    return { productId: result.productId, brand: toBrandResponse(result.brand) };
  }
}
