import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/index.js';
import { BrandController } from './brand.controller.js';
import { BrandRepository } from './brand.repository.js';
import { BrandService } from './brand.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import { ProductImageStorage } from './product-image.storage.js';
import {
  ProductImageMediaController,
  ProductImagesController,
} from './product-images.controller.js';
import { ProductImagesRepository } from './product-images.repository.js';
import { ProductImagesService } from './product-images.service.js';
import { ProductTrackingController } from './product-tracking.controller.js';
import { ProductTrackingService } from './product-tracking.service.js';

@Module({
  imports: [AuditModule],
  controllers: [
    CatalogController,
    ProductTrackingController,
    BrandController,
    ProductImagesController,
    ProductImageMediaController,
  ],
  providers: [
    CatalogRepository,
    CatalogService,
    ProductTrackingService,
    BrandRepository,
    BrandService,
    ProductImagesRepository,
    ProductImagesService,
    ProductImageStorage,
  ],
  exports: [CatalogService, BrandService, ProductImagesService],
})
export class CatalogModule {}
