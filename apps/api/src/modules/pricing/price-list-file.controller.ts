import { Controller, Get, Header, HttpCode, Post, Query, StreamableFile } from '@nestjs/common';
import { DEFAULT_LOCALE, commonProductName, priceTierSchema } from '@iorder/shared';
import type {
  PriceListPostRecipientsResponse,
  PriceListPostResponse,
  UnbrandedProductListResponse,
} from '@iorder/shared/staff-cost';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, RequirePermission } from '../../common/auth/route-access.js';
import { BrandService } from '../catalog/index.js';
import { PriceListExportService } from './price-list-export.service.js';
import { PriceListPostService } from './price-list-post.service.js';
import { PricingService } from './pricing.service.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** `?tier=`: which tier's file staff download [C, owner 2026-11-11]; STANDARD by default. */
const downloadQuerySchema = z.strictObject({ tier: priceTierSchema.default('STANDARD') });

// HTTP only. The price list Excel file ([C] 2026-10-28): download, "send to the groups now", and
// the products the file cannot place under a brand. Rules live in the services.
@Controller()
export class PriceListFileController {
  constructor(
    private readonly pricing: PricingService,
    private readonly exporter: PriceListExportService,
    private readonly posts: PriceListPostService,
    private readonly brands: BrandService,
  ) {}

  /**
   * The same file the chats receive (UZ, the groups' language), in the asked tier. Any staff role
   * that may browse (staff see both tiers on the staff price list anyway).
   */
  @Get('staff/price-list/current/excel')
  @RequirePermission('BROWSE_PRICE_LIST')
  @Header('Cache-Control', 'no-store')
  async download(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(downloadQuerySchema)) query: z.output<typeof downloadQuerySchema>,
  ): Promise<StreamableFile> {
    this.pricing.assertMayReadStaffList(actor);
    const file = await this.exporter.buildCurrent(DEFAULT_LOCALE, query.tier);
    return new StreamableFile(file.data, {
      type: XLSX_MIME,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.byteLength,
    });
  }

  @Post('staff/price-list/post-to-groups')
  @RequirePermission('UPDATE_PRICE_LIST')
  @HttpCode(200)
  async postToGroups(@CurrentActor() actor: Actor): Promise<PriceListPostResponse> {
    const result = await this.posts.postNow(actor);
    return {
      versionNumber: result.versionNumber,
      queuedGroupCount: result.queuedGroupCount,
      recipients: result.recipients,
      skipped: result.skipped,
    };
  }

  /** Who a post would reach right now, counted by tier and by chat kind, and who it skips. */
  @Get('staff/price-list/post-to-groups/recipients')
  @RequirePermission('UPDATE_PRICE_LIST')
  @Header('Cache-Control', 'no-store')
  async postRecipients(@CurrentActor() actor: Actor): Promise<PriceListPostRecipientsResponse> {
    const summary = await this.posts.preview(actor);
    return { recipients: summary.recipients, skipped: summary.skipped };
  }

  @Get('staff/brands/unbranded-products')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async unbranded(@CurrentActor() actor: Actor): Promise<UnbrandedProductListResponse> {
    const products = await this.brands.listUnbranded(actor);
    const { published } = await this.pricing.getPricedProductSets();
    const items = products.map((product) => ({
      productId: product.id,
      productCode: product.productCode,
      name: commonProductName(product.translations, product.productCode),
      category: product.category,
      priced: published.has(product.id),
    }));
    // Priced first (they are in the file now), then by name in code unit order (deterministic).
    items.sort(
      (a, b) =>
        Number(b.priced) - Number(a.priced) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.productCode < b.productCode ? -1 : a.productCode > b.productCode ? 1 : 0),
    );
    return { items };
  }
}
