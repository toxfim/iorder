import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { isSoldOutInSheet, orderablePieces } from './orderable-stock.js';
import { SupplyAllocationService } from './supply-allocation/supply-allocation.service.js';
import { AuditService, diffFields, type AuditChanges, type AuditValue } from '../audit/index.js';
import {
  BrandService,
  CatalogService,
  type ProductView,
  type SheetMatch,
} from '../catalog/index.js';
import { OrganizationsService } from '../organizations/index.js';
import {
  CURRENCY,
  PRICE_ENTRY_CURRENCY,
  type CreateDraftRequest,
  type PriceTier,
  type UpdateDraftRequest,
} from '@iorder/shared';
import { offeredInTier, productInTier } from './price-tier.js';
import type { PublishChangesInput, UpsertItemsInput } from './dto/pricing.schemas.js';
import { computePriceHistory, sameOptionalPrice } from './price-history.js';
import { formatMoney, toUsd, toUzs } from './price-money.js';
import { PricingRepository } from './pricing.repository.js';
import type {
  ItemPrices,
  ItemView,
  LastPriceChange,
  PriceHistoryEntry,
  PriceListView,
  PricedProduct,
  VersionSummaryView,
  VersionView,
} from './pricing.types.js';
import { UsdRateService, type UsdRateSnapshot } from './usd-rate/usd-rate.service.js';
import { assertVersionTransition } from './version-status.js';

const ENTITY_TYPE = 'PRICE_LIST_VERSION';

/**
 * OPEN BUSINESS QUESTION (not specified in the docs): may several DRAFTs exist at once?
 * Restrictive choice: at most one. The only other place that encodes it is the partial unique
 * index "price_list_versions_one_draft" in the migration; change both together.
 */
const MAX_OPEN_DRAFTS = 1;

@Injectable()
export class PricingService {
  constructor(
    private readonly repository: PricingRepository,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly usdRate: UsdRateService,
    private readonly holds: SupplyAllocationService,
    private readonly organizations: OrganizationsService,
    private readonly brands: BrandService,
  ) {}

  // -------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------

  /**
   * DESIGN NOTE (by design until the product owner decides otherwise): a published version
   * freezes prices only. Names, unit and isActive are read live from the catalog, so editing a
   * product name changes how an already published list looks. Do not "fix" this silently.
   *
   * The current published list for customers (and any actor who may browse). Active products only.
   *
   * The prices are those of the caller's organization's TIER [C, owner 2026-11-11], resolved here
   * on the server (hard rule 6): a STANDARD customer never receives a wholesale price and a
   * wholesale/partner customer never receives the standard price of an item that has a wholesale
   * one. The tier comes from the organization's current label; a staff viewer (no organization)
   * sees STANDARD. The view's wholesale fields are null, so a mapper cannot leak them.
   */
  async getCurrentForCustomer(actor: Actor): Promise<PriceListView> {
    this.assertMayBrowse(actor);
    const tier = await this.customerTierOf(actor);
    const list = await this.loadCurrentPublished();
    // A product the tier has no price for is not offered at all [C, owner 2026-11-12: Alif].
    const active = list.items.filter((i) => i.product.isActive && offeredInTier(i, tier));
    return {
      ...list,
      priceTier: tier,
      items: inUzs(active.map((item) => productInTier(item, tier))),
    };
  }

  /**
   * What the customer price list SHOWS (the catalog and the home page): `getCurrentForCustomer`
   * without the sheet products whose sheet stock is zero [C, owner 2026-11-19, isSoldOutInSheet].
   * The cart keeps reading the full list, so a line that ran out still has its prices and the
   * STOCK_EXCEEDED problem rather than turning into an unknown product.
   */
  async getCatalogForCustomer(actor: Actor): Promise<PriceListView> {
    const list = await this.getCurrentForCustomer(actor);
    return { ...list, items: await this.withoutSoldOutInSheet(list.items) };
  }

  /**
   * For other modules (the manager's new order [C, owner 2026-11-20]): exactly what this
   * organization's own customer catalog shows, at ITS tier (Alif: only the products with an Alif
   * price), without the sheet products whose sheet stock is zero (isSoldOutInSheet). The order is
   * priced from this same list, so nothing is offered that the order would not take. Not an
   * endpoint: the caller has authorized; the result is staff-mapped by the caller.
   */
  async getCatalogForOrganization(organizationId: string): Promise<PriceListView> {
    const tier = await this.organizations.findPriceTier(organizationId);
    const list = await this.loadCurrentPublished();
    const active = list.items.filter((i) => i.product.isActive && offeredInTier(i, tier));
    const items = inUzs(active.map((item) => productInTier(item, tier)));
    return { ...list, priceTier: tier, items: await this.withoutSoldOutInSheet(items) };
  }

  /** One stock read for the whole list, whatever its size. */
  private async withoutSoldOutInSheet<T extends PricedProduct>(items: readonly T[]): Promise<T[]> {
    const tracked = items.filter((i) => !i.product.codeGenerated).map((i) => i.product.id);
    if (tracked.length === 0) return [...items];
    const sheet = await this.catalog.getStockQuantities(tracked);
    return items.filter((i) => !isSoldOutInSheet(i.product, sheet.get(i.product.id)));
  }

  /**
   * The tier of the caller's organization; STANDARD for anyone without one. A staff viewer whose
   * orders go to the staging test organization (STAFF_ORDERING_ORGANIZATION_ID) is priced in THAT
   * organization's tier, so its order is priced as the organization's own would be (no
   * fallback for Alif factoring on staging either) [review 2026-11-12]; production sets none.
   */
  async customerTierOf(actor: Actor): Promise<PriceTier> {
    const organizationId =
      actor.staffRoles.length === 0
        ? (actor.membership?.organizationId ??
          actor.staffViewer?.orderingOrganizationId ??
          undefined)
        : undefined;
    return organizationId === undefined
      ? 'STANDARD'
      : this.organizations.findPriceTier(organizationId);
  }

  /**
   * How many whole pieces of each product a customer may order now [C, 2026-11-09], for the
   * customer price list and the cart; the caller has authorized the request. The same figure as
   * "available" on the staff stock page: for the products of the stock aggregate, each live
   * delivery line's quantity minus the holds of approved orders OF EVERY ORGANIZATION, added up;
   * zero when nothing is free (out of stock: it cannot be ordered). A product WITHOUT an entry has
   * no figure and no cap: it has no stock aggregate (unknown stock) or is staff-added (see
   * OrderableStock). A fixed number of queries whatever the list size. Quantities only: no cost, no supplier, nothing about who holds
   * what (hard rule 7). Indicative, never a reservation (hard rule 10).
   */
  async getOrderableStock(
    products: readonly Pick<ProductView, 'id' | 'codeGenerated'>[],
  ): Promise<Map<string, Prisma.Decimal>> {
    // A staff-added product has no delivery lines by rule: never a figure, whatever the tables hold.
    const tracked = products.filter((product) => !product.codeGenerated).map(({ id }) => id);
    if (tracked.length === 0) return new Map();
    // Only products WITH a stock aggregate come back: an unknown stock is not a limit. Among
    // them an exact zero stays in the map, and blocks.
    const free = await this.holds.availableFrom(await this.catalog.getStockQuantities(tracked));
    return new Map(
      [...free].map(([productId, quantity]) => [productId, orderablePieces(quantity)]),
    );
  }

  /**
   * The same list as `getCurrentForCustomer` for an internal caller that has no Actor yet (the
   * bot's Excel export). NOT an endpoint: the caller must have authorized the request, and must
   * map the result with the customer mapper. Only the PUBLISHED version, active products only.
   * Every price in USD (the Excel file's columns); an older UZS item is converted with the rate.
   * Like the customer catalog, it leaves out sheet products whose sheet stock is zero
   * [C, owner 2026-11-19]; a tier left with nothing is then not posted (price-list-post).
   */
  async getCurrentForExport(tier: PriceTier = 'STANDARD'): Promise<PriceListView> {
    const list = await this.loadCurrentPublished();
    const offered = list.items
      .filter((i) => i.product.isActive && offeredInTier(i, tier))
      .map((item) => productInTier(item, tier));
    return {
      ...list,
      priceTier: tier,
      items: inUsd(await this.withoutSoldOutInSheet(offered), list.usdRate),
    };
  }

  /**
   * USD rate snapshots of the given versions (staff-only data), for the staff DTOs. One query for
   * any number of versions; permission VIEW_COST_REFERENCE (manager, accountant, admin).
   */
  async getRateSnapshots(
    actor: Actor,
    versionIds: readonly string[],
  ): Promise<Map<string, UsdRateSnapshot>> {
    if (!can(actor, 'VIEW_COST_REFERENCE')) return new Map();
    return this.repository.findRateSnapshots(versionIds);
  }

  /** Ids of the products in the current published list (for the staff cost overview). */
  async getCurrentListProductIds(): Promise<{ versionNumber: number; productIds: string[] }> {
    const version = await this.repository.findPublished();
    if (!version) throw new NotFoundError('No price list has been published yet');
    const items = await this.repository.listItems(version.id);
    return { versionNumber: version.number, productIds: items.map((i) => i.productId) };
  }

  /**
   * Which products have a price in the current published list and in the open draft (staff-only
   * stock and unpriced views; the caller authorizes). One query; both sets are empty when there
   * is no published list / no draft.
   */
  async getPricedProductSets(): Promise<{ published: Set<string>; draft: Set<string> }> {
    const { published, draft } = await this.repository.findPricedProductIds();
    return { published: new Set(published), draft: new Set(draft) };
  }

  /** Staff view of the current published list: includes inactive products and metadata. */
  async getCurrentForStaff(actor: Actor): Promise<PriceListView> {
    this.assertMayBrowse(actor);
    this.assertIsStaff(actor);
    return this.loadCurrentPublished();
  }

  /** productId -> primary photo id of the list's products (one query), for the list DTOs. */
  primaryImageIds(list: PriceListView): Promise<Map<string, string>> {
    return this.catalog.primaryImageIds(list.items.map((item) => item.product.id));
  }

  /**
   * For the staff list DTO: the sheet product each generated-code item stands for by name
   * ("Sheetda bor" [P, design 2026-11-09]); one query for all of them, none when the list has no
   * generated-code item. Staff-only: the customer mapper never receives it.
   */
  sheetMatches(list: PriceListView): Promise<Map<string, SheetMatch>> {
    return this.catalog.findSheetMatches(list.items.map((item) => item.product));
  }

  /**
   * For the staff list DTO: each product's brand by the price list file's rule (staff choice, else
   * the brand finder); two queries for the whole list.
   */
  async brandNames(list: PriceListView): Promise<Map<string, string | null>> {
    const brands = await this.brands.resolveBrands(list.items.map((item) => item.product));
    return new Map([...brands].map(([productId, brand]) => [productId, brand?.name ?? null]));
  }

  /**
   * For the staff list DTO: when each product of the version's list last changed. The query reads
   * the whole price history, but its answer for one version never changes (published versions are
   * immutable and later ones are left out), so it runs once per published version and process.
   */
  lastPriceChanges(actor: Actor, version: { id: string }): Promise<Map<string, LastPriceChange>> {
    this.assertMayBrowse(actor);
    this.assertIsStaff(actor);
    if (this.lastChangesCache?.versionId !== version.id) {
      const changes = this.repository.findLastPriceChanges(version.id);
      this.lastChangesCache = { versionId: version.id, changes };
      // A failed read is not kept: the next request asks again.
      changes.catch(() => {
        if (this.lastChangesCache?.changes === changes) this.lastChangesCache = null;
      });
    }
    return this.lastChangesCache.changes;
  }

  private lastChangesCache: {
    versionId: string;
    changes: Promise<Map<string, LastPriceChange>>;
  } | null = null;

  /** The staff price list read check (any staff role that may browse), for the Excel download. */
  assertMayReadStaffList(actor: Actor): void {
    this.assertMayBrowse(actor);
    this.assertIsStaff(actor);
  }

  /** The PUBLISHED version (internal, no actor check), null when none is published yet. */
  findPublishedVersion(db?: DbClient): Promise<VersionView | null> {
    return this.repository.findPublished(db);
  }

  async listVersions(actor: Actor): Promise<VersionSummaryView[]> {
    this.assertMayView(actor);
    return this.repository.listVersions();
  }

  async getVersion(actor: Actor, id: string): Promise<PriceListView> {
    this.assertMayView(actor);
    const version = await this.requireVersion(id);
    return this.withProducts(version, await this.repository.listItems(id));
  }

  async getPriceHistory(
    actor: Actor,
    productId: string,
  ): Promise<{ product: ProductView; entries: PriceHistoryEntry[] }> {
    this.assertMayView(actor);
    const product = await this.catalog.requireProduct(productId);
    const [versions, prices] = await Promise.all([
      this.repository.listNonDraftVersions(),
      this.repository.findItemPricesByVersion(productId),
    ]);
    return { product, entries: computePriceHistory(versions, prices) };
  }

  // -------------------------------------------------------------------------------------
  // Draft lifecycle
  // -------------------------------------------------------------------------------------

  /** The open draft, or 404 when none exists (at most one can exist, MAX_OPEN_DRAFTS). */
  async getOpenDraft(actor: Actor): Promise<VersionView> {
    this.assertMayManage(actor);
    const draft = await this.repository.findOpenDraft();
    if (!draft) throw new NotFoundError('There is no open draft');
    return draft;
  }

  /**
   * `copyFromCurrent` copies the published prices but SKIPS items of inactive products: they
   * would be rejected at publish anyway. The count of skipped items is returned so the UI can say so.
   */
  async createDraft(
    actor: Actor,
    input: CreateDraftRequest,
  ): Promise<{ draft: VersionView; skippedInactiveCount: number }> {
    this.assertMayManage(actor);
    try {
      return await this.repository.transaction(async (tx) => {
        if ((await this.repository.countDrafts(tx)) >= MAX_OPEN_DRAFTS) {
          throw new ConflictError(
            'An open draft already exists; publish or discard it first',
            'DRAFT_ALREADY_OPEN',
          );
        }
        const published = input.copyFromCurrent ? await this.repository.findPublished(tx) : null;
        if (input.copyFromCurrent && !published) {
          throw new ConflictError(
            'There is no published price list to copy',
            'NO_PUBLISHED_VERSION',
          );
        }
        const draft = await this.repository.createVersion(tx, input.note);
        let itemCount = 0;
        let skippedInactiveCount = 0;
        if (published) {
          const source = await this.repository.listItems(published.id, tx);
          // Share lock, like every other check of isActive: a product deactivated while we copy
          // either is seen as inactive or waits until this transaction commits.
          const products = await this.catalog.findProductsLockedForShare(
            tx,
            source.map((item) => item.productId),
          );
          const activeIds = new Set(products.filter((p) => p.isActive).map((p) => p.id));
          const copied = source.filter((item) => activeIds.has(item.productId));
          await this.repository.createItems(tx, draft.id, copied);
          itemCount = copied.length;
          skippedInactiveCount = source.length - copied.length;
        }
        // A copy is a verbatim, reconstructible copy of an immutable version, so the audit row
        // records the source version and count rather than repeating every price.
        await this.audit.record(tx, {
          actorUserId: actor.userId,
          entityType: ENTITY_TYPE,
          entityId: draft.id,
          action: published ? 'PRICE_LIST_DRAFT_COPIED' : 'PRICE_LIST_DRAFT_CREATED',
          changes: diffFields(
            {},
            {
              number: draft.number,
              status: 'DRAFT',
              note: draft.note,
              copiedFromVersionId: published?.id ?? null,
              itemCount,
              skippedInactiveCount,
            },
          ),
        });
        return { draft, skippedInactiveCount };
      });
    } catch (error) {
      // Two creates raced past the count above; the partial unique index caught the loser.
      if (isUniqueViolation(error)) {
        throw new ConflictError('An open draft already exists', 'DRAFT_ALREADY_OPEN');
      }
      throw error;
    }
  }

  async updateDraft(actor: Actor, id: string, input: UpdateDraftRequest): Promise<VersionView> {
    this.assertMayManage(actor);
    return this.repository.transaction(async (tx) => {
      const draft = await this.lockEditableDraft(tx, id);
      await this.repository.updateNote(tx, id, input.note);
      const changes = diffFields({ note: draft.note }, { note: input.note });
      if (Object.keys(changes).length > 0) {
        await this.recordVersion(tx, actor, id, 'PRICE_LIST_DRAFT_UPDATED', changes);
      }
      return { ...draft, note: input.note };
    });
  }

  async upsertDraftItems(
    actor: Actor,
    id: string,
    input: UpsertItemsInput,
  ): Promise<PriceListView> {
    this.assertMayManage(actor);
    return this.repository.transaction(async (tx) => {
      const draft = await this.lockEditableDraft(tx, id);
      // Inside the transaction and under a share lock on the products: a concurrent
      // deactivation either finished before this check (we see it) or waits until we commit.
      await this.assertProductsCanBePriced(
        tx,
        input.items.map((i) => i.productId),
      );
      const existing = new Map(
        (await this.repository.listItems(id, tx)).map((i) => [i.productId, i]),
      );
      const changes: AuditChanges = {};
      const toCreate: ({ productId: string } & PricedItem)[] = [];
      const toUpdate: ({ productId: string } & PricedItem)[] = [];
      for (const entry of input.items) {
        const before = existing.get(entry.productId);
        // Omitted wholesale prices keep what the draft has (as in the no-draft publish).
        const item = {
          productId: entry.productId,
          basePrice: entry.basePrice,
          deferredPrice: entry.deferredPrice,
          rrp: entry.rrp,
          wholesalePrice:
            entry.wholesalePrice === undefined
              ? (before?.wholesalePrice ?? null)
              : entry.wholesalePrice,
          wholesaleDeferredPrice:
            entry.wholesaleDeferredPrice === undefined
              ? (before?.wholesaleDeferredPrice ?? null)
              : entry.wholesaleDeferredPrice,
          alifPrice: entry.alifPrice === undefined ? (before?.alifPrice ?? null) : entry.alifPrice,
          alifDeferredPrice:
            entry.alifDeferredPrice === undefined
              ? (before?.alifDeferredPrice ?? null)
              : entry.alifDeferredPrice,
          currency: PRICE_ENTRY_CURRENCY,
        };
        assertWholesalePair(item);
        assertAlifPair(item);
        const diff = itemPriceChanges(item.productId, before ?? null, item);
        if (Object.keys(diff).length === 0) continue;
        (before ? toUpdate : toCreate).push(item);
        Object.assign(changes, diff);
      }
      // Two statements for up to 500 items instead of 500 round trips in one transaction.
      await this.repository.createItems(tx, id, toCreate);
      await this.repository.updateItemPrices(tx, id, toUpdate);
      if (Object.keys(changes).length > 0) {
        await this.recordVersion(tx, actor, id, 'PRICE_LIST_ITEMS_CHANGED', changes);
      }
      return this.withProducts(draft, await this.repository.listItems(id, tx), tx);
    });
  }

  async removeDraftItem(actor: Actor, id: string, productId: string): Promise<void> {
    this.assertMayManage(actor);
    await this.repository.transaction(async (tx) => {
      await this.lockEditableDraft(tx, id);
      const before = (await this.repository.listItems(id, tx)).find(
        (i) => i.productId === productId,
      );
      if (!before) throw new NotFoundError('Item not found in this draft');
      await this.repository.deleteItem(tx, id, productId);
      await this.recordVersion(
        tx,
        actor,
        id,
        'PRICE_LIST_ITEM_REMOVED',
        itemPriceChanges(productId, before, null),
      );
    });
  }

  async discardDraft(actor: Actor, id: string): Promise<void> {
    this.assertMayManage(actor);
    await this.repository.transaction(async (tx) => {
      const draft = await this.lockEditableDraft(tx, id);
      await this.deleteDraftWithAudit(tx, actor, draft);
    });
  }

  /**
   * The staff app has no drafts [C, 2026-10-28]: the edits against the published list are
   * published as a new version in ONE transaction. New list = published list without its
   * inactive products (counted in `skippedInactiveCount`) - `removedProductIds` + `upserts`.
   *
   * `baseVersionNumber` is the version the person edited: when it is no longer the published
   * one, nothing changes and the caller gets PRICE_LIST_CHANGED (a colleague's publish is never
   * overwritten unseen). The row lock on the published version serializes concurrent calls; the
   * unique indexes are the backstop.
   */
  async publishChanges(
    actor: Actor,
    input: PublishChangesInput,
  ): Promise<{ version: VersionView; skippedInactiveCount: number }> {
    this.assertMayManage(actor);
    return this.inPublishTransaction((tx) => this.publishChangesIn(tx, actor, input));
  }

  /**
   * One transaction for a publish and whatever must be atomic with it (a staff-added product, a
   * merge, an import). A lost publish race at either unique index (one PUBLISHED, one DRAFT) is
   * reported as ANOTHER_VERSION_PUBLISHED. The caller has authorized the actor.
   */
  async inPublishTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.repository.transaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Another version was published first', 'ANOTHER_VERSION_PUBLISHED');
      }
      throw error;
    }
  }

  /**
   * Locks the PUBLISHED version row (the lock every publish takes first) and returns it as it is
   * under the lock; null before the first publish. Callers that lock other rows in the same
   * transaction take this lock first, in the order `publishChangesIn` does, so none deadlocks it.
   */
  async lockPublished(tx: Tx): Promise<VersionView | null> {
    const known = await this.repository.findPublished(tx);
    if (known) await this.repository.lockStatus(tx, known.id);
    // Re-read under the lock: a publish that just committed may have archived `known`.
    return this.repository.findPublished(tx);
  }

  /** The published version with its items (no products joined); null before the first publish. */
  async currentPublishedItems(
    db?: DbClient,
  ): Promise<{ version: VersionView; items: ItemView[] } | null> {
    const version = await this.repository.findPublished(db);
    if (!version) return null;
    return { version, items: await this.repository.listItems(version.id, db) };
  }

  /**
   * `publishChanges` inside the caller's transaction (opened with `inPublishTransaction`): the
   * staff-added product, the merge and the import publish their list through this one method. The
   * caller has authorized the actor.
   */
  async publishChangesIn(
    tx: Tx,
    actor: Actor,
    input: PublishChangesInput,
  ): Promise<{ version: VersionView; skippedInactiveCount: number }> {
    const previous = await this.lockPublished(tx);
    const currentVersionNumber = previous?.number ?? null;
    if (currentVersionNumber !== input.baseVersionNumber) {
      throw new ConflictError('The price list changed meanwhile', 'PRICE_LIST_CHANGED', {
        currentVersionNumber,
      });
    }
    // A draft left over from the old draft flow would block the transient DRAFT below
    // (one open draft at the database level); it is discarded, with its audit row.
    const leftover = await this.repository.findOpenDraft(tx);
    if (leftover) {
      await this.repository.lockStatus(tx, leftover.id);
      await this.deleteDraftWithAudit(tx, actor, leftover);
    }

    const source = previous ? await this.repository.listItems(previous.id, tx) : [];
    const sourceProducts = await this.catalog.findProductsLockedForShare(
      tx,
      source.map((item) => item.productId),
    );
    const activeIds = new Set(sourceProducts.filter((p) => p.isActive).map((p) => p.id));
    const kept = source.filter((item) => activeIds.has(item.productId));
    const skippedInactiveCount = source.length - kept.length;

    await this.assertProductsCanBePriced(
      tx,
      input.upserts.map((i) => i.productId),
    );
    const removed = new Set(input.removedProductIds);
    // Kept items keep their own currency; every new price is entered in USD.
    const next = new Map<string, PricedItem>();
    for (const item of kept) {
      if (!removed.has(item.productId)) next.set(item.productId, item);
    }
    const sourceById = new Map(source.map((item) => [item.productId, item]));
    for (const upsert of input.upserts) {
      const was = sourceById.get(upsert.productId);
      // An omitted wholesale price keeps the published one (a client that does not know the tier
      // never wipes it); null removes it.
      const wholesalePrice =
        upsert.wholesalePrice === undefined ? (was?.wholesalePrice ?? null) : upsert.wholesalePrice;
      const wholesaleDeferredPrice =
        upsert.wholesaleDeferredPrice === undefined
          ? (was?.wholesaleDeferredPrice ?? null)
          : upsert.wholesaleDeferredPrice;
      assertWholesalePair({ wholesalePrice, wholesaleDeferredPrice });
      // The Alif factoring tier follows the same rule [C, owner 2026-11-12].
      const alifPrice =
        upsert.alifPrice === undefined ? (was?.alifPrice ?? null) : upsert.alifPrice;
      const alifDeferredPrice =
        upsert.alifDeferredPrice === undefined
          ? (was?.alifDeferredPrice ?? null)
          : upsert.alifDeferredPrice;
      assertAlifPair({ alifPrice, alifDeferredPrice });
      next.set(upsert.productId, {
        basePrice: upsert.basePrice,
        deferredPrice: upsert.deferredPrice,
        rrp: upsert.rrp,
        wholesalePrice,
        wholesaleDeferredPrice,
        alifPrice,
        alifDeferredPrice,
        currency: PRICE_ENTRY_CURRENCY,
      });
    }
    if (next.size === 0) {
      throw new ConflictError('The price list cannot be left empty', 'EMPTY_PRICE_LIST');
    }
    // The kept items were priced before, so this is the unit check on the whole list.
    await this.assertProductsCanBePriced(tx, [...next.keys()]);

    const before = new Map(source.map((item) => [item.productId, item]));
    const changes: AuditChanges = {
      baseVersionNumber: { from: null, to: input.baseVersionNumber },
      skippedInactiveCount: { from: null, to: skippedInactiveCount },
    };
    for (const [productId, prices] of next) {
      Object.assign(changes, itemPriceChanges(productId, before.get(productId) ?? null, prices));
    }
    for (const [productId, was] of before) {
      if (!next.has(productId)) Object.assign(changes, itemPriceChanges(productId, was, null));
    }

    const created = await this.repository.createVersion(tx, null);
    const items = [...next].map(([productId, prices]) => ({
      productId,
      basePrice: prices.basePrice,
      deferredPrice: prices.deferredPrice,
      rrp: prices.rrp,
      wholesalePrice: prices.wholesalePrice,
      wholesaleDeferredPrice: prices.wholesaleDeferredPrice,
      alifPrice: prices.alifPrice,
      alifDeferredPrice: prices.alifDeferredPrice,
      currency: prices.currency,
    }));
    await this.repository.createItems(tx, created.id, items);
    const version = await this.publishVersion(
      tx,
      actor,
      created.id,
      items.length,
      previous,
      changes,
    );
    return { version, skippedInactiveCount };
  }

  /** The manage check (UPDATE_PRICE_LIST), for the services that publish through this one. */
  assertMayManagePriceList(actor: Actor): void {
    this.assertMayManage(actor);
  }

  /**
   * "Exactly one PUBLISHED version" is "at most one" at the database level (partial unique
   * index): zero exist only before the first publish, or after manual admin SQL. Publishing
   * never leaves the list without a current version.
   *
   * ONE transaction: lock the draft, archive the current PUBLISHED version, publish the draft,
   * write the audit rows. The row lock serializes concurrent publishes; the loser then sees a
   * non-DRAFT status and gets a conflict. The partial unique index is the backstop.
   */
  async publish(actor: Actor, id: string): Promise<VersionView> {
    this.assertMayManage(actor);
    try {
      return await this.repository.transaction(async (tx) => {
        const status = await this.repository.lockStatus(tx, id);
        if (status === null) throw new NotFoundError('Price list version not found');
        assertVersionTransition(status, 'PUBLISHED');

        const items = await this.repository.listItems(id, tx);
        if (items.length === 0) {
          throw new ConflictError('An empty price list cannot be published', 'EMPTY_DRAFT');
        }
        // A product may have been deactivated while it sat in the draft. Re-check under a share
        // lock so none can slip into the PUBLISHED version.
        await this.assertProductsCanBePriced(
          tx,
          items.map((i) => i.productId),
          {
            message: 'Remove inactive products from the draft before publishing',
            reason: 'INACTIVE_PRODUCT_IN_DRAFT',
          },
        );

        const previous = await this.repository.findPublished(tx);
        return this.publishVersion(tx, actor, id, items.length, previous, {});
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Another version was published first', 'ANOTHER_VERSION_PUBLISHED');
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------

  /**
   * The publish steps shared by the draft publish and `publishChanges`: archive the current
   * PUBLISHED version first (the unique index allows only one at any moment), snapshot the USD
   * rate, flip the DRAFT to PUBLISHED and write the audit rows. `extraChanges` go into the
   * PRICE_LIST_PUBLISHED row (the item diffs of a no-draft publish).
   */
  private async publishVersion(
    tx: Tx,
    actor: Actor,
    id: string,
    itemCount: number,
    previous: VersionView | null,
    extraChanges: AuditChanges,
  ): Promise<VersionView> {
    const publishedAt = this.clock.now();
    if (previous) {
      assertVersionTransition(previous.status, 'ARCHIVED');
      await this.repository.archive(tx, previous.id);
      await this.recordVersion(tx, actor, previous.id, 'PRICE_LIST_ARCHIVED', {
        status: { from: 'PUBLISHED', to: 'ARCHIVED' },
        replacedByVersionId: { from: null, to: id },
      });
    }
    // The USD rate in force is copied onto the version (staff-only, immutable afterwards). It is
    // written BEFORE the status change: the guard only accepts it while the version is a DRAFT.
    // No rate yet: no snapshot, and publishing is NOT blocked.
    const snapshot = await this.usdRate.readSnapshot(tx);
    if (snapshot) await this.repository.insertRateSnapshot(tx, id, snapshot);
    await this.repository.publish(tx, id, publishedAt, actor.userId);
    await this.recordVersion(tx, actor, id, 'PRICE_LIST_PUBLISHED', {
      status: { from: 'DRAFT', to: 'PUBLISHED' },
      publishedAt: { from: null, to: publishedAt.toISOString() },
      publishedBy: { from: null, to: actor.userId },
      replacedVersionId: { from: null, to: previous?.id ?? null },
      itemCount: { from: null, to: itemCount },
      usdRate: { from: null, to: snapshot ? snapshot.rate.toFixed(4) : null },
      usdRateSource: { from: null, to: snapshot?.source ?? null },
      usdRateDate: { from: null, to: snapshot?.rateDate ?? null },
      ...extraChanges,
    });

    const published = await this.repository.findVersion(id, tx);
    if (!published) throw new NotFoundError('Price list version not found');
    return published;
  }

  /** Deletes a (locked) draft; its items go with it, so their prices are kept in the audit row. */
  private async deleteDraftWithAudit(tx: Tx, actor: Actor, draft: VersionView): Promise<void> {
    const items = await this.repository.listItems(draft.id, tx);
    await this.recordVersion(tx, actor, draft.id, 'PRICE_LIST_DRAFT_DISCARDED', {
      status: { from: draft.status, to: null },
      ...itemRemovals(items),
    });
    await this.repository.deleteDraft(tx, draft.id);
  }

  /** The current published list with both tiers (staff and internal readers). */
  private async loadCurrentPublished(): Promise<PriceListView> {
    const version = await this.repository.findPublished();
    if (!version) throw new NotFoundError('No price list has been published yet');
    return this.withProducts(version, await this.repository.listItems(version.id));
  }

  private async requireVersion(id: string, tx?: DbClient): Promise<VersionView> {
    const version = await this.repository.findVersion(id, tx);
    if (!version) throw new NotFoundError('Price list version not found');
    return version;
  }

  /** Locks the version and proves it is still a DRAFT; published versions are never edited. */
  private async lockEditableDraft(tx: Tx, id: string): Promise<VersionView> {
    const status = await this.repository.lockStatus(tx, id);
    if (status === null) throw new NotFoundError('Price list version not found');
    if (status !== 'DRAFT') {
      // PUBLISHED: the draft the client addressed was published meanwhile. ARCHIVED: an old
      // version, never editable.
      throw new ConflictError(
        `Only a draft can be edited; this version is ${status}`,
        status === 'PUBLISHED' ? 'DRAFT_NOT_OPEN' : 'VERSION_NOT_DRAFT',
      );
    }
    return this.requireVersion(id, tx);
  }

  private async assertProductsCanBePriced(
    tx: Tx,
    productIds: readonly string[],
    inactive: { message: string; reason: 'INACTIVE_PRODUCT' | 'INACTIVE_PRODUCT_IN_DRAFT' } = {
      message: 'Inactive products cannot be priced',
      reason: 'INACTIVE_PRODUCT',
    },
  ): Promise<void> {
    const found = await this.catalog.findProductsLockedForShare(tx, productIds);
    const byId = new Map(found.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new NotFoundError('Unknown product', { productIds: missing });
    const inactiveIds = found.filter((p) => !p.isActive).map((p) => p.id);
    if (inactiveIds.length > 0) {
      throw new ConflictError(inactive.message, inactive.reason, { productIds: inactiveIds });
    }
  }

  /** Joins the products and adds the UZS prices at the USD rate in force now. */
  private async withProducts(
    version: VersionView,
    items: readonly ItemView[],
    db?: DbClient,
  ): Promise<PriceListView> {
    const usdRate = (await this.usdRate.readSnapshot(db))?.rate ?? null;
    const products = new Map(
      (await this.catalog.findProductsByIds(items.map((i) => i.productId))).map((p) => [p.id, p]),
    );
    const priced: PricedProduct[] = [];
    for (const item of items) {
      const product = products.get(item.productId);
      // Cannot happen (foreign key), but never drop a price silently.
      if (!product) throw new Error(`Product ${item.productId} missing for a price list item`);
      const prices = pricesOf(item);
      priced.push({
        product,
        ...prices,
        currency: item.currency,
        uzs: uzsPrices(item, usdRate),
        usd: item.currency === PRICE_ENTRY_CURRENCY ? prices : null,
      });
    }
    priced.sort((a, b) => a.product.productCode.localeCompare(b.product.productCode));
    return { version, priceTier: null, items: priced, usdRate };
  }

  private recordVersion(
    tx: Tx,
    actor: Actor,
    versionId: string,
    action: string,
    changes: AuditChanges,
  ): Promise<void> {
    return this.audit.record(tx, {
      actorUserId: actor.userId,
      entityType: ENTITY_TYPE,
      entityId: versionId,
      action,
      changes,
    });
  }

  private assertMayManage(actor: Actor): void {
    if (!can(actor, 'UPDATE_PRICE_LIST')) throw new ForbiddenError('Access denied');
  }

  private assertMayView(actor: Actor): void {
    if (!can(actor, 'VIEW_PRICE_ADMIN')) throw new ForbiddenError('Access denied');
  }

  /**
   * The matrix has one BROWSE_PRICE_LIST action for customers and staff alike, and the staff
   * view carries version metadata customers must not see. So the staff view additionally
   * requires a staff role. Sound because staff are never organization members (Actor doc,
   * [C] 2026-10-20): no customer can hold a staff role. Deliberately not a new permission action.
   */
  private assertIsStaff(actor: Actor): void {
    if (actor.staffRoles.length === 0) throw new ForbiddenError('Access denied');
  }

  private assertMayBrowse(actor: Actor): void {
    if (!can(actor, 'BROWSE_PRICE_LIST')) throw new ForbiddenError('Access denied');
  }
}

type PricedItem = ItemPrices & { currency: string };

/**
 * A wholesale deferred price needs a wholesale sale price (also a CHECK): checked on the merged
 * values (an omitted field is kept), so a bad pair is a 400, never a database error.
 */
function assertWholesalePair(
  item: Pick<ItemPrices, 'wholesalePrice' | 'wholesaleDeferredPrice'>,
): void {
  if (item.wholesaleDeferredPrice !== null && item.wholesalePrice === null) {
    throw new InputValidationError([
      { path: 'items', message: 'A wholesale deferred price needs a wholesale sale price' },
    ]);
  }
}

/** The same for the Alif factoring tier [C, owner 2026-11-12] (also a CHECK). */
function assertAlifPair(item: Pick<ItemPrices, 'alifPrice' | 'alifDeferredPrice'>): void {
  if (item.alifDeferredPrice !== null && item.alifPrice === null) {
    throw new InputValidationError([
      { path: 'items', message: 'An Alif deferred price needs an Alif sale price' },
    ]);
  }
}

function uzsPrices(item: PricedItem, usdRate: Prisma.Decimal | null): ItemPrices | null {
  const basePrice = toUzs(item.basePrice, item.currency, usdRate);
  if (basePrice === null) return null;
  // The sale price converted, so the rate is known and an optional price converts the same way.
  const optional = (amount: Prisma.Decimal | null): Prisma.Decimal | null =>
    amount === null ? null : toUzs(amount, item.currency, usdRate);
  return {
    basePrice,
    deferredPrice: optional(item.deferredPrice),
    rrp: optional(item.rrp),
    wholesalePrice: optional(item.wholesalePrice),
    wholesaleDeferredPrice: optional(item.wholesaleDeferredPrice),
    alifPrice: optional(item.alifPrice),
    alifDeferredPrice: optional(item.alifDeferredPrice),
  };
}

/** The price fields of an item, nothing else (explicit, so no other column rides along). */
function pricesOf(item: ItemPrices): ItemPrices {
  return {
    basePrice: item.basePrice,
    deferredPrice: item.deferredPrice,
    rrp: item.rrp,
    wholesalePrice: item.wholesalePrice,
    wholesaleDeferredPrice: item.wholesaleDeferredPrice,
    alifPrice: item.alifPrice,
    alifDeferredPrice: item.alifDeferredPrice,
  };
}

/**
 * The list as customers see it: every price in UZS (hard rule 1). A USD item without a known rate
 * has no UZS price, so it is left out (it cannot be ordered) rather than shown in dollars.
 */
function inUzs(items: readonly PricedProduct[]): PricedProduct[] {
  return items.flatMap((item) =>
    item.uzs === null ? [] : [{ ...item, ...item.uzs, currency: CURRENCY }],
  );
}

/** The list in USD; an older UZS item without a known rate cannot be shown and is left out. */
function inUsd(items: readonly PricedProduct[], usdRate: Prisma.Decimal | null): PricedProduct[] {
  return items.flatMap((item) => {
    const basePrice = toUsd(item.basePrice, item.currency, usdRate);
    if (basePrice === null) return [];
    const optional = (amount: Prisma.Decimal | null): Prisma.Decimal | null =>
      amount === null ? null : toUsd(amount, item.currency, usdRate);
    return [
      {
        ...item,
        basePrice,
        deferredPrice: optional(item.deferredPrice),
        rrp: optional(item.rrp),
        wholesalePrice: optional(item.wholesalePrice),
        wholesaleDeferredPrice: optional(item.wholesaleDeferredPrice),
        alifPrice: optional(item.alifPrice),
        alifDeferredPrice: optional(item.alifDeferredPrice),
        currency: PRICE_ENTRY_CURRENCY,
      },
    ];
  });
}

function itemRemovals(items: readonly ItemView[]): AuditChanges {
  return Object.assign({}, ...items.map((i) => itemPriceChanges(i.productId, i, null)));
}

/**
 * Audit entries for one item's prices: `item.<id>.basePrice`, `item.<id>.deferredPrice` and
 * `item.<id>.rrp`, each only when it changed. `before`/`after` null = the item is absent (added or
 * removed).
 */
function itemPriceChanges(
  productId: string,
  before: PricedItem | null,
  after: PricedItem | null,
): AuditChanges {
  const changes: AuditChanges = {};
  if (before && after && before.currency !== after.currency) {
    changes[`item.${productId}.currency`] = { from: before.currency, to: after.currency };
  }
  const money = (value: Prisma.Decimal | null | undefined): AuditValue =>
    value ? formatMoney(value) : null;
  const baseBefore = before?.basePrice ?? null;
  const baseAfter = after?.basePrice ?? null;
  if (!sameOptionalPrice(baseBefore, baseAfter)) {
    changes[`item.${productId}.basePrice`] = { from: money(baseBefore), to: money(baseAfter) };
  }
  const deferredBefore = before?.deferredPrice ?? null;
  const deferredAfter = after?.deferredPrice ?? null;
  if (!sameOptionalPrice(deferredBefore, deferredAfter)) {
    changes[`item.${productId}.deferredPrice`] = {
      from: money(deferredBefore),
      to: money(deferredAfter),
    };
  }
  const rrpBefore = before?.rrp ?? null;
  const rrpAfter = after?.rrp ?? null;
  if (!sameOptionalPrice(rrpBefore, rrpAfter)) {
    changes[`item.${productId}.rrp`] = { from: money(rrpBefore), to: money(rrpAfter) };
  }
  for (const field of [
    'wholesalePrice',
    'wholesaleDeferredPrice',
    'alifPrice',
    'alifDeferredPrice',
  ] as const) {
    const was = before?.[field] ?? null;
    const is = after?.[field] ?? null;
    if (!sameOptionalPrice(was, is)) {
      changes[`item.${productId}.${field}`] = { from: money(was), to: money(is) };
    }
  }
  return changes;
}
