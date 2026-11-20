import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { CurrentActor, CustomerArea, RequirePermission } from '../../common/auth/route-access.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import {
  createDraftRequestSchema,
  customerPriceListQuerySchema,
  updateDraftRequestSchema,
  uuidSchema,
  type CreateDraftRequest,
  type CustomerPriceListQuery,
  type CustomerPriceListResponse,
  type PriceHistoryResponse,
  type UpdateDraftRequest,
} from '@iorder/shared';
// Staff version DTOs carry the USD rate snapshot (cost-class), so they come from the staff entry.
import type {
  CreateDraftWithRateResponse,
  PublishChangesWithRateResponse,
  StaffPriceListWithRateResponse,
  StaffVersionListWithRateResponse,
  StaffVersionWithRateResponse,
} from '@iorder/shared/staff-cost';
import {
  publishChangesSchema,
  upsertItemsSchema,
  type PublishChangesInput,
  type UpsertItemsInput,
} from './dto/pricing.schemas.js';
import {
  toCreateDraftWithRate,
  toCustomerPriceListResponse,
  toPriceHistoryResponse,
  toPublishChangesWithRate,
  toStaffPriceListWithRate,
  toStaffVersionListWithRate,
  toStaffVersionWithRate,
} from './dto/pricing.response.js';
import { IdentityService } from '../identity/index.js';
import { PricingService } from './pricing.service.js';

const idParam = (name: string) => Param(name, new ZodValidationPipe(uuidSchema));

// HTTP only: validation, actor, mapping. Rules live in PricingService.
@Controller()
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly identity: IdentityService,
  ) {}

  private publisherNames(
    rows: readonly { publishedBy: string | null }[],
  ): Promise<Map<string, string>> {
    return this.identity.findDisplayNames(
      rows.flatMap((row) => (row.publishedBy === null ? [] : [row.publishedBy])),
    );
  }

  // Customer area: a staff member reads it as the staff viewer ([C] 2026-11-09), through the same
  // allow-listed customer DTO as everyone else.
  @Get('price-list/current')
  @CustomerArea()
  @RequirePermission('BROWSE_PRICE_LIST')
  async current(
    @CurrentActor() actor: Actor,
    // `lang` is still validated (the customer app sends it) but no longer changes the names: every
    // reader sees one common product name (owner, 2026-10-28).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- validated, intentionally unused
    @Query(new ZodValidationPipe(customerPriceListQuerySchema)) _query: CustomerPriceListQuery,
  ): Promise<CustomerPriceListResponse> {
    const list = await this.pricing.getCatalogForCustomer(actor);
    const [images, orderableStock] = await Promise.all([
      this.pricing.primaryImageIds(list),
      this.pricing.getOrderableStock(list.items.map((item) => item.product)),
    ]);
    return toCustomerPriceListResponse(list, images, orderableStock);
  }

  @Get('staff/price-list/current')
  @RequirePermission('BROWSE_PRICE_LIST')
  async staffCurrent(@CurrentActor() actor: Actor): Promise<StaffPriceListWithRateResponse> {
    const list = await this.pricing.getCurrentForStaff(actor);
    const [snapshots, images, sheetMatches, brands, lastChanges] = await Promise.all([
      this.pricing.getRateSnapshots(actor, [list.version.id]),
      this.pricing.primaryImageIds(list),
      this.pricing.sheetMatches(list),
      this.pricing.brandNames(list),
      // Read for the same version as the list, so a publish in between cannot mix two lists.
      this.pricing.lastPriceChanges(actor, list.version),
    ]);
    return toStaffPriceListWithRate(
      list,
      snapshots,
      images,
      await this.publisherNames([list.version, ...lastChanges.values()]),
      sheetMatches,
      { brands, lastChanges },
    );
  }

  @Get('staff/price-list/versions')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async versions(@CurrentActor() actor: Actor): Promise<StaffVersionListWithRateResponse> {
    const versions = await this.pricing.listVersions(actor);
    const snapshots = await this.pricing.getRateSnapshots(
      actor,
      versions.map((v) => v.id),
    );
    return toStaffVersionListWithRate(versions, snapshots, await this.publisherNames(versions));
  }

  @Get('staff/price-list/versions/:id')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async version(
    @CurrentActor() actor: Actor,
    @idParam('id') id: string,
  ): Promise<StaffPriceListWithRateResponse> {
    const list = await this.pricing.getVersion(actor, id);
    const [snapshots, images, sheetMatches] = await Promise.all([
      this.pricing.getRateSnapshots(actor, [list.version.id]),
      this.pricing.primaryImageIds(list),
      this.pricing.sheetMatches(list),
    ]);
    return toStaffPriceListWithRate(
      list,
      snapshots,
      images,
      await this.publisherNames([list.version]),
      sheetMatches,
    );
  }

  @Post('staff/price-list/drafts')
  @RequirePermission('UPDATE_PRICE_LIST')
  async createDraft(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createDraftRequestSchema)) body: CreateDraftRequest,
  ): Promise<CreateDraftWithRateResponse> {
    const { draft, skippedInactiveCount } = await this.pricing.createDraft(actor, body);
    // A new draft has no snapshot yet (it is taken at publish time).
    return toCreateDraftWithRate(draft, skippedInactiveCount, new Map(), new Map());
  }

  @Get('staff/price-list/drafts/current')
  @RequirePermission('UPDATE_PRICE_LIST')
  async currentDraft(@CurrentActor() actor: Actor): Promise<StaffVersionWithRateResponse> {
    return toStaffVersionWithRate(await this.pricing.getOpenDraft(actor), new Map(), new Map());
  }

  @Patch('staff/price-list/drafts/:id')
  @RequirePermission('UPDATE_PRICE_LIST')
  async updateDraft(
    @CurrentActor() actor: Actor,
    @idParam('id') id: string,
    @Body(new ZodValidationPipe(updateDraftRequestSchema)) body: UpdateDraftRequest,
  ): Promise<StaffVersionWithRateResponse> {
    return toStaffVersionWithRate(
      await this.pricing.updateDraft(actor, id, body),
      new Map(),
      new Map(),
    );
  }

  @Put('staff/price-list/drafts/:id/items')
  @RequirePermission('UPDATE_PRICE_LIST')
  async upsertItems(
    @CurrentActor() actor: Actor,
    @idParam('id') id: string,
    @Body(new ZodValidationPipe(upsertItemsSchema)) body: UpsertItemsInput,
  ): Promise<StaffPriceListWithRateResponse> {
    // Only drafts are edited here, and a draft has no snapshot.
    const list = await this.pricing.upsertDraftItems(actor, id, body);
    const [images, sheetMatches] = await Promise.all([
      this.pricing.primaryImageIds(list),
      this.pricing.sheetMatches(list),
    ]);
    return toStaffPriceListWithRate(list, new Map(), images, new Map(), sheetMatches);
  }

  @Delete('staff/price-list/drafts/:id/items/:productId')
  @RequirePermission('UPDATE_PRICE_LIST')
  @HttpCode(204)
  async removeItem(
    @CurrentActor() actor: Actor,
    @idParam('id') id: string,
    @idParam('productId') productId: string,
  ): Promise<void> {
    await this.pricing.removeDraftItem(actor, id, productId);
  }

  @Delete('staff/price-list/drafts/:id')
  @RequirePermission('UPDATE_PRICE_LIST')
  @HttpCode(204)
  async discardDraft(@CurrentActor() actor: Actor, @idParam('id') id: string): Promise<void> {
    await this.pricing.discardDraft(actor, id);
  }

  @Post('staff/price-list/drafts/:id/publish')
  @RequirePermission('UPDATE_PRICE_LIST')
  @HttpCode(200)
  async publish(
    @CurrentActor() actor: Actor,
    @idParam('id') id: string,
  ): Promise<StaffVersionWithRateResponse> {
    const published = await this.pricing.publish(actor, id);
    return toStaffVersionWithRate(
      published,
      await this.pricing.getRateSnapshots(actor, [published.id]),
      await this.publisherNames([published]),
    );
  }

  /**
   * The staff app has no drafts [C, 2026-10-28]: the edited changes against the published list
   * become a new PUBLISHED version in one transaction.
   */
  @Post('staff/price-list/publish')
  @RequirePermission('UPDATE_PRICE_LIST')
  @HttpCode(200)
  async publishChanges(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(publishChangesSchema)) body: PublishChangesInput,
  ): Promise<PublishChangesWithRateResponse> {
    const { version, skippedInactiveCount } = await this.pricing.publishChanges(actor, body);
    return toPublishChangesWithRate(
      version,
      skippedInactiveCount,
      await this.pricing.getRateSnapshots(actor, [version.id]),
      await this.publisherNames([version]),
    );
  }

  @Get('staff/products/:id/price-history')
  @RequirePermission('VIEW_PRICE_ADMIN')
  async priceHistory(
    @CurrentActor() actor: Actor,
    @idParam('id') id: string,
  ): Promise<PriceHistoryResponse> {
    const { product, entries } = await this.pricing.getPriceHistory(actor, id);
    return toPriceHistoryResponse(product, entries, await this.publisherNames(entries));
  }
}
