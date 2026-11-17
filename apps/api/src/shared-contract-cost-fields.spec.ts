import * as shared from '@iorder/shared';
import * as staffCost from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import {
  findStaffOnlyFields,
  findStaffOnlyFieldsInCustomerCart,
  findStaffOnlyFieldsInCustomerPriceList,
  isForbiddenName,
  isStaffOnlyJsonKey,
  STAFF_PRICE_TIER_NAMES,
} from '../test/support/forbidden-fields.js';
import { collectSchemaKeys, isZodSchema } from '../test/support/schema-keys.js';

// Hard rule 7 at the contract level.
//
// The staff-only cost schemas are allow-listed HERE, as a literal, on purpose: the production
// export STAFF_ONLY_COST_SCHEMAS is only a second assertion. If the list were read from
// production code alone, adding a cost key to a customer schema AND its name to that array
// would silence this scan.
const STAFF_ONLY_COST_SCHEMA_NAMES = [
  'costDeliverySchema',
  'costDeliverySummarySchema',
  'createDraftWithRateResponseSchema',
  'priceListCostItemSchema',
  'priceListCostsResponseSchema',
  'productCostReferenceResponseSchema',
  'publishChangesWithRateResponseSchema',
  'publishWithRateResponseSchema',
  'staffPriceListWithRateResponseSchema',
  'staffVersionListWithRateResponseSchema',
  'staffVersionSummaryWithRateResponseSchema',
  'staffVersionWithRateResponseSchema',
  'supplyRemovalDecisionResponseSchema',
  'supplyRemovalLineSchema',
  'supplyRemovalListResponseSchema',
  'supplyRemovalRequestSchema',
  'updateUsdRateRequestSchema',
  'usdRateResponseSchema',
  'usdRateSnapshotSchema',
  'usdRateStringSchema',
  // Staff product / unpriced / stock views (category, stock, latest delivery are staff-only).
  'categoryCountSchema',
  'latestDeliverySchema',
  'staffProductDetailListQuerySchema',
  'staffProductDetailListResponseSchema',
  'staffProductDetailResponseSchema',
  'stockOverviewItemSchema',
  'stockOverviewQuerySchema',
  'stockOverviewResponseSchema',
  'unpricedProductSchema',
  'unpricedProductsQuerySchema',
  'unpricedProductsResponseSchema',
  // Product categories and the per-unit code rule (staff catalog management).
  'createProductCategoriesRequestSchema',
  'createProductCategoryRequestSchema',
  'productCategoryListResponseSchema',
  'productCategoryResponseSchema',
  'sheetCategoryListResponseSchema',
  'sheetCategoryResponseSchema',
  'updateProductCategoryRequestSchema',
  'updateProductTrackingRequestSchema',
  // Persisted sheet sync reports.
  'sheetSyncCostMismatchSchema',
  'sheetSyncRejectedRowSchema',
  'sheetSyncRunCountsSchema',
  'sheetSyncRunSchema',
  'sheetSyncRunsQuerySchema',
  'sheetSyncRunsResponseSchema',
  'sheetSyncRequestResponseSchema',
  'sheetSyncSkippedSupplierSchema',
  // Party numbers on supplies (manager; refs, quantities and dates, no cost).
  'partyNumberSchema',
  'setSupplyPartyRequestSchema',
  'setSupplyPartyResponseSchema',
  'supplyListResponseSchema',
  'supplyNotAvailableDetailsSchema',
  'supplyPartyChangedDetailsSchema',
  'supplyPartyConflictDetailsSchema',
  'supplyPartyStateSchema',
  'supplySearchQuerySchema',
  'supplySummarySchema',
  // Brands of the price list Excel file and the "send to the groups" answer (manager, admin).
  'brandListResponseSchema',
  'brandNameSchema',
  'brandResponseSchema',
  'createBrandRequestSchema',
  'priceListPostResponseSchema',
  'priceListPostRecipientsSchema',
  'priceListPostSkippedSchema',
  'priceListPostRecipientsResponseSchema',
  'productBrandResponseSchema',
  'setProductBrandRequestSchema',
  'unbrandedProductListResponseSchema',
  'unbrandedProductSchema',
  // Staff-added products without a sheet code and the price list Excel import (manager, admin).
  'createManualProductRequestSchema',
  'createManualProductResponseSchema',
  'manualProductCheckQuerySchema',
  'manualProductCheckResponseSchema',
  'mergePreviewQuerySchema',
  'mergePreviewResponseSchema',
  'mergeProductRequestSchema',
  'mergeProductResponseSchema',
  'priceImportConfirmRequestSchema',
  'priceImportConfirmResponseSchema',
  'priceImportPreviewResponseSchema',
  'priceImportPreviewRowSchema',
  'priceImportRowRequestSchema',
  'priceImportSummarySchema',
  'priceImportTemplateQuerySchema',
  'similarProductSchema',
  // Newer-model pairs the manager confirms or rejects (manager, admin).
  'decideProductSuccessionRequestSchema',
  'findProductSuccessionsResponseSchema',
  'productSuccessionListQuerySchema',
  'productSuccessionListResponseSchema',
  'productSuccessionProductSchema',
  'productSuccessionSchema',
  // The by-order products with their open-order demand (the roles of the stock page).
  'byOrderOpenOrderSchema',
  'byOrderProductSchema',
  'byOrderProductsResponseSchema',
] as const;

// The schemas that may declare the customer's stock figure (and, for the price list, the
// category), with exactly what each may declare. A literal on purpose, like the list above.
const STOCK_FIGURE_SCHEMAS: Readonly<Record<string, string[]>> = {
  customerPriceListResponseSchema: ['category', 'orderableStock'],
  cartLineSchema: ['orderableStock'],
  cartResponseSchema: ['orderableStock'],
  stockLimitExceededDetailsSchema: ['orderableStock'],
  // The customer home recommendations [C, 2026-11-09]: product cards like the price list items.
  customerRecommendationItemSchema: ['orderableStock'],
  customerReorderItemSchema: ['orderableStock'],
  customerMatchingItemSchema: ['orderableStock'],
  customerNewerModelItemSchema: ['orderableStock'],
  // Three cards types in one answer: the walker reports the figure once per card schema.
  customerHomeRecommendationsResponseSchema: ['orderableStock', 'orderableStock', 'orderableStock'],
};
// What a customer parses: the four above may hold the figure, the order answers hold no stock key.
const CUSTOMER_ANSWER_SCHEMAS = [
  ...Object.keys(STOCK_FIGURE_SCHEMAS),
  'customerOrderSchema',
  'customerOrderListResponseSchema',
  'customerTimelineResponseSchema',
];

// [C, owner 2026-11-11] The staff price list and its requests carry the «Оптовик/Партнер» SELLING
// tier (not cost). A literal: only these barrel schemas may declare those exact names; every
// customer schema is still scanned without them.
const STAFF_PRICE_TIER_SCHEMAS: readonly string[] = [
  'staffPriceListResponseSchema',
  'upsertItemsRequestSchema',
  'publishChangesRequestSchema',
];

type Schema = Parameters<typeof collectSchemaKeys>[0];
const zodExports = (module: Record<string, unknown>): [string, Schema][] =>
  Object.entries(module).filter((entry): entry is [string, Schema] => isZodSchema(entry[1]));

describe('the package barrel (customer web reaches only this) has no cost-like keys at all', () => {
  const schemas = zodExports(shared);

  it('finds the customer and staff schemas', () => {
    const names = schemas.map(([name]) => name);
    for (const expected of [
      'customerPriceListResponseSchema',
      'staffPriceListResponseSchema',
      'upsertItemsRequestSchema',
      'staffProductResponseSchema',
      'priceHistoryResponseSchema',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it.each(schemas.map(([name]) => name))('%s declares no forbidden key', (name) => {
    const schema = schemas.find(([n]) => n === name)![1];
    const tierAllowed = STAFF_PRICE_TIER_SCHEMAS.includes(name) ? STAFF_PRICE_TIER_NAMES : [];
    expect(
      collectSchemaKeys(schema).filter((key) => isForbiddenName(key) && !tierAllowed.includes(key)),
    ).toEqual([]);
  });

  it('no customer answer declares a price tier key', () => {
    for (const name of CUSTOMER_ANSWER_SCHEMAS) {
      const schema = schemas.find(([n]) => n === name)?.[1];
      expect(schema, name).toBeDefined();
      if (schema === undefined) continue;
      expect(
        collectSchemaKeys(schema).filter((key) => /wholesale|alif/i.test(key)),
        name,
      ).toEqual([]);
    }
  });

  it.each(schemas.map(([name]) => name))(
    '%s (customer or staff DTO outside the cost entry) declares no staff-only delivery or stock field',
    (name) => {
      const schema = schemas.find(([n]) => n === name)![1];
      // Owner decisions: the customer price list items carry `category` (2026-10-23) and the
      // stock figure `orderableStock` (2026-11-09); the cart line and the stock refusal carry the
      // figure too. Nothing else staff-only, and no other schema may declare either.
      const expected = STOCK_FIGURE_SCHEMAS[name] ?? [];
      expect(collectSchemaKeys(schema).filter(isStaffOnlyJsonKey).sort()).toEqual(expected);
    },
  );

  it('the stock figure is the only stock-like key a customer answer declares', () => {
    // Any key that merely CONTAINS "stock" (a renamed leak such as `sheetStock`) must be the one
    // allowed figure, and only in the schemas allowed to carry it.
    for (const name of CUSTOMER_ANSWER_SCHEMAS) {
      const schema = schemas.find(([n]) => n === name)?.[1];
      expect(schema, name).toBeDefined();
      const stockLike = collectSchemaKeys(schema!).filter((key) => /stock/i.test(key));
      const allowed = name in STOCK_FIGURE_SCHEMAS ? ['orderableStock'] : [];
      expect([...new Set(stockLike)], name).toEqual(allowed);
    }
  });

  it('the order-route leak scan allows the stock figure on cart and refusal lines only', () => {
    const line = { productId: 'p', quantity: '2.000', orderableStock: 45 };
    expect(findStaffOnlyFieldsInCustomerCart({ lines: [line], totalAmount: '1.00' })).toEqual([]);
    expect(
      findStaffOnlyFieldsInCustomerCart({
        error: { code: 'CONFLICT', details: { lines: [{ productId: 'p', orderableStock: 45 }] } },
      }),
    ).toEqual([]);
    // An order (its lines are `items`), the top level and anything deeper still report it.
    expect(findStaffOnlyFieldsInCustomerCart({ items: [line] })).toEqual([
      '$.items[0].orderableStock',
    ]);
    expect(findStaffOnlyFieldsInCustomerCart({ orderableStock: 45, lines: [] })).toEqual([
      '$.orderableStock',
    ]);
    expect(
      findStaffOnlyFieldsInCustomerCart({ lines: [{ ...line, product: { orderableStock: 45 } }] }),
    ).toEqual(['$.lines[0].product.orderableStock']);
    // Every other stock name stays a hit on a cart line.
    expect(
      findStaffOnlyFieldsInCustomerCart({ lines: [{ ...line, stock: 1, availableQuantity: '2' }] }),
    ).toEqual(['$.lines[0].stock', '$.lines[0].availableQuantity']);
  });

  it('the customer price list leak scan allows `category` and the stock figure on items only', () => {
    const item = { productCode: 'A', category: 'Кабели', orderableStock: 45 };
    expect(
      findStaffOnlyFieldsInCustomerPriceList({ version: { orderableStock: 45 }, items: [] }),
    ).toEqual(['$.version.orderableStock']);
    expect(
      findStaffOnlyFieldsInCustomerPriceList({
        items: [{ ...item, nested: { orderableStock: 1 } }],
      }),
    ).toEqual(['$.items[0].nested.orderableStock']);
    expect(findStaffOnlyFieldsInCustomerPriceList({ version: {}, items: [item] })).toEqual([]);
    expect(
      findStaffOnlyFieldsInCustomerPriceList({ version: { category: 'x' }, items: [] }),
    ).toEqual(['$.version.category']);
    expect(findStaffOnlyFieldsInCustomerPriceList({ category: 'x', items: [] })).toEqual([
      '$.category',
    ]);
    expect(
      findStaffOnlyFieldsInCustomerPriceList({ items: [{ ...item, supplier: 's', stock: 1 }] }),
    ).toEqual(['$.items[0].supplier', '$.items[0].stock']);
    expect(
      findStaffOnlyFieldsInCustomerPriceList({ items: [{ ...item, nested: { category: 'x' } }] }),
    ).toEqual(['$.items[0].nested.category']);
  });

  it('the leak scans flag any key containing `categor`, outside the one allowed place', () => {
    const item = { productCode: 'A', category: 'Кабели' };
    expect(
      findStaffOnlyFieldsInCustomerPriceList({
        items: [{ ...item, categoryName: 'x', supplierCategory: 'y' }],
      }),
    ).toEqual(['$.items[0].categoryName', '$.items[0].supplierCategory']);
    expect(
      findStaffOnlyFieldsInCustomerPriceList({ version: { Categories: [] }, items: [item] }),
    ).toEqual(['$.version.Categories']);
    expect(findStaffOnlyFields({ order: { uncategorizedCount: 1 } })).toEqual([
      '$.order.uncategorizedCount',
    ]);
  });

  it('exports none of the cost schemas, their routes or their allow-list', () => {
    const exported = Object.keys(shared);
    for (const name of [
      ...STAFF_ONLY_COST_SCHEMA_NAMES,
      'COST_ROUTES',
      'BRAND_ROUTES',
      'STAFF_ONLY_COST_SCHEMAS',
    ]) {
      expect(exported, name).not.toContain(name);
    }
  });

  it('walks nested customer DTO keys (sanity check of the walker)', () => {
    const keys = collectSchemaKeys(shared.customerPriceListResponseSchema);
    expect(keys).toEqual(
      expect.arrayContaining(['version', 'items', 'price', 'currency', 'productCode']),
    );
  });
});

describe('the staff-cost entry', () => {
  it('exports exactly the hard-coded allow-listed schemas (no silent additions)', () => {
    const names = zodExports(staffCost)
      .map(([name]) => name)
      .sort();
    expect(names).toEqual([...STAFF_ONLY_COST_SCHEMA_NAMES].sort());
  });

  it('the production allow-list agrees with the literal (second assertion)', () => {
    expect([...staffCost.STAFF_ONLY_COST_SCHEMAS].sort()).toEqual(
      [...STAFF_ONLY_COST_SCHEMA_NAMES].sort(),
    );
  });

  it('carries supplier, purchaseMethod, category and stockQuantity (staff-only fields live here)', () => {
    const keys = zodExports(staffCost).flatMap(([, schema]) => collectSchemaKeys(schema));
    for (const field of ['supplier', 'purchaseMethod', 'category', 'stockQuantity']) {
      expect(keys, field).toContain(field);
    }
  });

  it('really has cost-like keys, so the allow-list is not stale', () => {
    const keys = zodExports(staffCost).flatMap(([, schema]) => collectSchemaKeys(schema));
    expect(keys.filter(isForbiddenName).length).toBeGreaterThan(0);
  });
});
