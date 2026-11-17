export { CatalogModule } from './catalog.module.js';
export {
  CatalogService,
  type ManualProductInput,
  type MergeMoves,
  type MergePair,
  type ProductsFromSheetResult,
  type SheetMatch,
  type StockReplaceResult,
} from './catalog.service.js';
export { SIMILAR_PRODUCTS_LIMIT } from './product-name-match.js';
export { BrandService } from './brand.service.js';
export { ProductImagesService, type ExportThumbnail } from './product-images.service.js';
export type {
  BrandView,
  ProductTranslationView,
  ProductView,
  ProductWithStock,
} from './product.view.js';
