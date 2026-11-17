import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CatalogService } from './catalog.service.js';
import {
  createProductRequestSchema,
  updateProductRequestSchema,
  uuidSchema,
  type CreateProductRequest,
  type UpdateProductRequest,
} from '@iorder/shared';
import {
  staffProductDetailListQuerySchema,
  type StaffProductDetailListQuery,
  type StaffProductDetailListResponse,
  type StaffProductDetailResponse,
} from '@iorder/shared/staff-cost';
import { toStaffProductResponse } from './dto/product.response.js';

// HTTP only: validation, actor, mapping. Rules live in CatalogService. The responses are the
// staff-only product DTOs (they carry the sheet's category), see @iorder/shared/staff-cost.
@Controller('staff/products')
@RequirePermission('UPDATE_PRICE_LIST')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission('VIEW_PRICE_ADMIN')
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(staffProductDetailListQuerySchema))
    query: StaffProductDetailListQuery,
  ): Promise<StaffProductDetailListResponse> {
    const products = await this.catalog.listProducts(actor, query);
    return { items: products.map(toStaffProductResponse) };
  }

  @Get(':id')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async get(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<StaffProductDetailResponse> {
    return toStaffProductResponse(await this.catalog.getProduct(actor, id));
  }

  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createProductRequestSchema)) body: CreateProductRequest,
  ): Promise<StaffProductDetailResponse> {
    return toStaffProductResponse(await this.catalog.createProduct(actor, body));
  }

  @Patch(':id')
  @HttpCode(200)
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(updateProductRequestSchema)) body: UpdateProductRequest,
  ): Promise<StaffProductDetailResponse> {
    return toStaffProductResponse(await this.catalog.updateProduct(actor, id, body));
  }
}
