import { z } from 'zod';
import { DEFAULT_LOCALE } from '../roles.js';
import {
  isoInstantSchema,
  languageCodeSchema,
  moneyStringSchema,
  orderableStockSchema,
  uuidSchema,
} from './common.js';
import { productPrimaryImageShape } from './product-images.js';

export const PRICE_LIST_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];
export const PRICE_LIST_SOURCES = ['MANUAL', 'SHEET_IMPORT'] as const;
export type PriceListSource = (typeof PRICE_LIST_SOURCES)[number];

/** The currency customers see and orders are kept in (hard rule 1). */
export const CURRENCY = 'UZS';

/**
 * Currencies of a price list item [owner 2026-10-29]: prices are entered in USD; items priced
 * before that date stay in UZS. The UZS amount of a USD item is derived from the USD rate.
 */
export const PRICE_LIST_CURRENCIES = ['USD', 'UZS'] as const;
export type PriceListCurrency = (typeof PRICE_LIST_CURRENCIES)[number];
export const PRICE_ENTRY_CURRENCY = 'USD' satisfies PriceListCurrency;

/** Upper bound of items in one bulk upsert request. */
export const MAX_ITEMS_PER_REQUEST = 500;

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

const note = z.string().trim().max(500).nullable();

export const createDraftRequestSchema = z.strictObject({
  copyFromCurrent: z.boolean().default(false),
  note: note.default(null),
});
export type CreateDraftRequest = z.output<typeof createDraftRequestSchema>;

export const updateDraftRequestSchema = z.strictObject({ note });
export type UpdateDraftRequest = z.output<typeof updateDraftRequestSchema>;

/**
 * Every price in USD [owner 2026-10-29]: `basePrice` is the sale price ("Цена $"), `deferredPrice`
 * the optional deferred-payment price ("Отсрочка $", pay in parts), `rrp` the optional recommended
 * retail price [C, 2026-11-09] (shown to customers, never charged). null (or omitted) = none: an
 * upsert replaces the whole item, so a client that edits a price sends the RRP it wants kept.
 */
const priceItem = z
  .strictObject({
    productId: uuidSchema,
    basePrice: moneyStringSchema,
    deferredPrice: moneyStringSchema.nullable().default(null),
    rrp: moneyStringSchema.nullable().default(null),
    /**
     * The «Оптовик/Партнер» tier [C, owner 2026-11-11]: sale and deferred price in USD for the
     * WHOLESALE_PARTNER tier. OMITTED = keep what the published list has for the product (so a
     * client that does not know the tier never wipes it); null = none. Without a wholesale sale price
     * that tier's customers see the STANDARD prices [P].
     */
    wholesalePrice: moneyStringSchema.nullable().optional(),
    wholesaleDeferredPrice: moneyStringSchema.nullable().optional(),
    /**
     * The «Alif factoring» tier [C, owner 2026-11-12], same rules as the wholesale prices (OMITTED =
     * keep, null = none). Without an Alif sale price the product is not offered to that tier.
     */
    alifPrice: moneyStringSchema.nullable().optional(),
    alifDeferredPrice: moneyStringSchema.nullable().optional(),
  })
  .refine(
    (item) => !(item.wholesalePrice === null && typeof item.wholesaleDeferredPrice === 'string'),
    'A wholesale deferred price needs a wholesale sale price',
  )
  .refine(
    (item) => !(item.alifPrice === null && typeof item.alifDeferredPrice === 'string'),
    'An Alif deferred price needs an Alif sale price',
  );

export const upsertItemsRequestSchema = z
  .strictObject({
    items: z.array(priceItem).min(1).max(MAX_ITEMS_PER_REQUEST),
  })
  .refine(
    ({ items }) => new Set(items.map((i) => i.productId)).size === items.length,
    'Each product may appear once',
  );
export type UpsertItemsRequest = z.output<typeof upsertItemsRequestSchema>;

/**
 * The staff app has NO drafts [C, 2026-10-28]: one request replaces the published price list and
 * publishes the result as a new version in ONE transaction. The new list = the current published
 * list (its inactive products are dropped and counted in `skippedInactiveCount`) + `upserts`
 * (new prices, also for products not in the list yet) - `removedProductIds`.
 *
 * `baseVersionNumber` is the published version the person edited (null before the first
 * publish). When another version was published meanwhile the api answers 409 PRICE_LIST_CHANGED
 * and changes nothing, so a colleague's prices are never overwritten unseen.
 */
export const publishChangesRequestSchema = z
  .strictObject({
    baseVersionNumber: z.number().int().positive().nullable(),
    upserts: z.array(priceItem).max(MAX_ITEMS_PER_REQUEST).default([]),
    removedProductIds: z.array(uuidSchema).max(MAX_ITEMS_PER_REQUEST).default([]),
  })
  .refine(
    ({ upserts }) => new Set(upserts.map((i) => i.productId)).size === upserts.length,
    'Each product may appear once',
  )
  .refine(
    ({ removedProductIds }) => new Set(removedProductIds).size === removedProductIds.length,
    'Each removed product may appear once',
  )
  .refine(({ upserts, removedProductIds }) => {
    const removed = new Set(removedProductIds);
    return upserts.every((i) => !removed.has(i.productId));
  }, 'A product cannot be priced and removed in the same request')
  .refine(
    ({ upserts, removedProductIds }) => upserts.length + removedProductIds.length > 0,
    'Nothing to publish',
  );
export type PublishChangesRequest = z.output<typeof publishChangesRequestSchema>;

export const customerPriceListQuerySchema = z.strictObject({
  lang: languageCodeSchema.default(DEFAULT_LOCALE),
});
export type CustomerPriceListQuery = z.output<typeof customerPriceListQuerySchema>;

// ---------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------

/** Same limit as the stored product category (staff catalog entry); kept separate on purpose. */
export const CUSTOMER_CATEGORY_MAX_LENGTH = 200;

/**
 * Customer price list. Strict allow-list: any extra key (for example a cost field) makes
 * parsing fail, so a leak is caught on the web side and in tests (hard rule 7).
 *
 * `category` is the ONE category label a customer may see (owner decision 2026-10-23): the raw
 * sheet string, only on this list, for browsing. It is not cost data. null = no category.
 * `imageUrl` (thumb) and `imageLargeUrl` (large) are the product's primary photo, null without one.
 * `orderableStock` is the ONE stock figure a customer may see (owner decision 2026-11-09).
 */
export const customerPriceListResponseSchema = z.strictObject({
  version: z.strictObject({ number: z.number().int(), publishedAt: isoInstantSchema }),
  items: z.array(
    z.strictObject({
      productId: z.uuid(),
      productCode: z.string(),
      unit: z.string(),
      name: z.string(),
      /** The sale price in UZS (converted on the server when the list is kept in USD). */
      price: moneyStringSchema,
      /** The deferred-payment ("Отсрочка") price in UZS; null = none. */
      deferredPrice: moneyStringSchema.nullable(),
      /**
       * The recommended retail price (RRP) in UZS [C, 2026-11-09]: what the shop may sell one piece
       * for. Information only, never what an order costs; null = none.
       */
      rrp: moneyStringSchema.nullable(),
      /**
       * How many pieces can be ordered now [C, 2026-11-09]; 0 = out of stock (cannot be ordered),
       * null = show nothing, no cap. The one stock figure a customer sees: a total over all
       * customers, no cost and no supplier.
       */
      orderableStock: orderableStockSchema,
      currency: z.literal(CURRENCY),
      category: z.string().trim().min(1).max(CUSTOMER_CATEGORY_MAX_LENGTH).nullable(),
      ...productPrimaryImageShape,
    }),
  ),
});
export type CustomerPriceListResponse = z.infer<typeof customerPriceListResponseSchema>;

export const staffVersionResponseSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  status: z.enum(PRICE_LIST_STATUSES),
  note: z.string().nullable(),
  source: z.enum(PRICE_LIST_SOURCES),
  createdAt: isoInstantSchema,
  publishedAt: isoInstantSchema.nullable(),
  /** The publisher's display name, never an id; null when unknown. */
  publishedBy: z.string().nullable(),
  /** The publisher's id for the person card; null when the person is unknown. */
  publishedByUserId: z.uuid().nullable(),
});
export type StaffVersionResponse = z.infer<typeof staffVersionResponseSchema>;

/**
 * Response of POST /staff/price-list/drafts. `skippedInactiveCount` is how many items of the
 * published list were NOT copied because their product is inactive (0 unless copyFromCurrent).
 */
export const createDraftResponseSchema = staffVersionResponseSchema.extend({
  skippedInactiveCount: z.number().int().nonnegative(),
});
export type CreateDraftResponse = z.infer<typeof createDraftResponseSchema>;

/**
 * Response of POST /staff/price-list/publish: the new PUBLISHED version. `skippedInactiveCount`
 * is how many items of the previous list were dropped because their product is inactive.
 */
export const publishChangesResponseSchema = staffVersionResponseSchema.extend({
  skippedInactiveCount: z.number().int().nonnegative(),
});
export type PublishChangesResponse = z.infer<typeof publishChangesResponseSchema>;

export const staffVersionSummaryResponseSchema = staffVersionResponseSchema.extend({
  itemCount: z.number().int().nonnegative(),
});
export type StaffVersionSummaryResponse = z.infer<typeof staffVersionSummaryResponseSchema>;

export const staffVersionListResponseSchema = z.strictObject({
  items: z.array(staffVersionSummaryResponseSchema),
});
export type StaffVersionListResponse = z.infer<typeof staffVersionListResponseSchema>;

/** When and by whom a product's prices last changed ("O'zgargan" in Narxlar). */
export const staffPriceChangeSchema = z.strictObject({
  versionNumber: z.number().int(),
  changedAt: isoInstantSchema,
  /** The publisher's display name, never an id; null when unknown. */
  changedBy: z.string().nullable(),
});
export type StaffPriceChange = z.infer<typeof staffPriceChangeSchema>;

/** Version detail / current staff list / result of an item upsert. */
export const staffPriceListResponseSchema = z.strictObject({
  version: staffVersionResponseSchema,
  items: z.array(
    z.strictObject({
      productId: z.uuid(),
      productCode: z.string(),
      unit: z.string(),
      isActive: z.boolean(),
      /** A staff-added product without a sheet «Товар_ID» [C, 2026-11-09]: no stock is ever shown. */
      codeGenerated: z.boolean(),
      /**
       * For a generated-code product: the active sheet product with the same common name (ignoring
       * case and spacing), the likely merge target ("Sheetda bor" in the staff list); null otherwise.
       */
      sheetMatch: z
        .strictObject({ productId: uuidSchema, productCode: z.string(), name: z.string() })
        .nullable(),
      names: z.array(z.strictObject({ lang: languageCodeSchema, name: z.string() })),
      /** The sale price ("Цена") as stored, in `currency`. */
      basePrice: moneyStringSchema,
      /** The deferred-payment price ("Отсрочка") as stored, in `currency`; null = none. */
      deferredPrice: moneyStringSchema.nullable(),
      /** The recommended retail price (RRP) as stored, in `currency` [C, 2026-11-09]; null = none. */
      rrp: moneyStringSchema.nullable(),
      /**
       * The «Оптовик/Партнер» tier as stored, in `currency` [C, owner 2026-11-11]; null = none (that
       * tier's customers then see the STANDARD prices [P]).
       */
      wholesalePrice: moneyStringSchema.nullable(),
      wholesaleDeferredPrice: moneyStringSchema.nullable(),
      /**
       * The «Alif factoring» tier as stored, in `currency` [C, owner 2026-11-12]; null = none (the
       * product is then not offered to that tier).
       */
      alifPrice: moneyStringSchema.nullable(),
      alifDeferredPrice: moneyStringSchema.nullable(),
      currency: z.enum(PRICE_LIST_CURRENCIES),
      /** Both prices in UZS at the current USD rate; null = a USD price while no rate is set. */
      uzs: z
        .strictObject({ basePrice: moneyStringSchema, deferredPrice: moneyStringSchema.nullable() })
        .nullable(),
      /**
       * The product's brand by the price list file's rule (the brand staff chose, else the brand
       * finder on the name); null = none, and always null outside the current list. Narxlar
       * filters by it (design approved 2026-11-19).
       */
      brand: z.string().nullable(),
      /**
       * The latest published version in which one of this product's prices (any tier, RRP, the
       * currency) changed or the product entered the list [P]; null outside the current list.
       */
      lastChange: staffPriceChangeSchema.nullable(),
      ...productPrimaryImageShape,
    }),
  ),
});
export type StaffPriceListResponse = z.infer<typeof staffPriceListResponseSchema>;

/** Response of publish and of draft create/update. */
export const publishResponseSchema = staffVersionResponseSchema;
export type PublishResponse = z.infer<typeof publishResponseSchema>;

export const priceHistoryEntrySchema = z.strictObject({
  versionId: z.uuid(),
  versionNumber: z.number().int(),
  publishedAt: isoInstantSchema,
  /** The publisher's display name, never an id; null when unknown. */
  publishedBy: z.string().nullable(),
  /** The publisher's id for the person card; null when the person is unknown. */
  publishedByUserId: z.uuid().nullable(),
  source: z.enum(PRICE_LIST_SOURCES),
  /** null = the product was not in the previous published version. */
  oldPrice: moneyStringSchema.nullable(),
  /** null = the product was removed from the list in this version. */
  newPrice: moneyStringSchema.nullable(),
  /** Deferred-payment prices around the change; null = none (or no item). */
  oldDeferredPrice: moneyStringSchema.nullable(),
  newDeferredPrice: moneyStringSchema.nullable(),
  /** Recommended retail prices (RRP) around the change; null = none (or no item). */
  oldRrp: moneyStringSchema.nullable(),
  newRrp: moneyStringSchema.nullable(),
  /** Currency of the old prices (they may predate the switch to USD). */
  oldCurrency: z.enum(PRICE_LIST_CURRENCIES),
  currency: z.enum(PRICE_LIST_CURRENCIES),
});
export type PriceHistoryEntry = z.infer<typeof priceHistoryEntrySchema>;

export const priceHistoryResponseSchema = z.strictObject({
  productId: z.uuid(),
  productCode: z.string(),
  entries: z.array(priceHistoryEntrySchema),
});
export type PriceHistoryResponse = z.infer<typeof priceHistoryResponseSchema>;
