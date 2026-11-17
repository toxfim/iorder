import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { uuidSchema } from '@iorder/shared';
import {
  createProductCategoriesRequestSchema,
  suggestCategoryCodeRule,
  createProductCategoryRequestSchema,
  updateProductCategoryRequestSchema,
  updateProductTrackingRequestSchema,
  type CreateProductCategoriesRequest,
  type CreateProductCategoryRequest,
  type ProductCategoryListResponse,
  type ProductCategoryResponse,
  type SheetCategoryListResponse,
  type StaffProductDetailResponse,
  type UpdateProductCategoryRequest,
  type UpdateProductTrackingRequest,
} from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { toProductCategoryResponse, toStaffProductResponse } from './dto/product.response.js';
import { ProductTrackingService } from './product-tracking.service.js';

const idPipe = new ZodValidationPipe(uuidSchema);

// HTTP only: validation, actor, mapping. Rules live in ProductTrackingService.
@Controller('staff')
@RequirePermission('UPDATE_PRICE_LIST')
export class ProductTrackingController {
  constructor(private readonly tracking: ProductTrackingService) {}

  @Get('product-categories')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async listCategories(@CurrentActor() actor: Actor): Promise<ProductCategoryListResponse> {
    const items = await this.tracking.listCategories(actor);
    return { items: items.map(toProductCategoryResponse) };
  }

  @Post('product-categories')
  async createCategory(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createProductCategoryRequestSchema))
    body: CreateProductCategoryRequest,
  ): Promise<ProductCategoryResponse> {
    return toProductCategoryResponse(await this.tracking.createCategory(actor, body));
  }

  @Get('product-categories/sheet')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async listSheetCategories(@CurrentActor() actor: Actor): Promise<SheetCategoryListResponse> {
    const items = await this.tracking.listSheetCategories(actor);
    return {
      items: items.map((c) => {
        const rule = suggestCategoryCodeRule(c.name);
        return {
          name: c.name,
          productCount: c.productCount,
          suggestedTrackingType: rule.trackingType,
          suggestedMarkingRequired: rule.markingRequired,
        };
      }),
    };
  }

  @Post('product-categories/bulk')
  async createCategories(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createProductCategoriesRequestSchema))
    body: CreateProductCategoriesRequest,
  ): Promise<ProductCategoryListResponse> {
    const items = await this.tracking.createCategories(actor, body.items);
    return { items: items.map(toProductCategoryResponse) };
  }

  @Patch('product-categories/:id')
  @HttpCode(200)
  async updateCategory(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateProductCategoryRequestSchema))
    body: UpdateProductCategoryRequest,
  ): Promise<ProductCategoryResponse> {
    return toProductCategoryResponse(await this.tracking.updateCategory(actor, id, body));
  }

  @Put('products/:id/tracking')
  @HttpCode(200)
  async updateProductTracking(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateProductTrackingRequestSchema))
    body: UpdateProductTrackingRequest,
  ): Promise<StaffProductDetailResponse> {
    return toStaffProductResponse(await this.tracking.updateProductTracking(actor, id, body));
  }
}
