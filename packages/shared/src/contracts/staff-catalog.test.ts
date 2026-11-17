import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';
import {
  COST_ROUTES,
  sheetSyncRunSchema,
  sheetSyncRunsQuerySchema,
  staffProductDetailListQuerySchema,
  staffProductDetailResponseSchema,
  stockOverviewQuerySchema,
  stockOverviewResponseSchema,
  unpricedProductsQuerySchema,
  unpricedProductsResponseSchema,
} from '../staff-cost.js';
import * as staffCost from '../staff-cost.js';

const id = '019a0000-0000-7000-8000-000000000001';
const at = '2026-10-20T08:00:00.000Z';

const run = {
  id,
  startedAt: at,
  finishedAt: at,
  status: 'OK',
  trigger: 'MANUAL',
  counts: {
    rowsRead: 1,
    created: 1,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    skippedRows: 0,
    staleRefs: 0,
    mismatches: 0,
    createdProducts: 0,
    removalsRequested: 0,
    removalsDismissed: 0,
    reappearedAfterRemoval: 0,
  },
  rejectedRows: [{ header: 'Дата', reason: 'Expected a date', deliveryRef: 'R-1' }],
  skippedSuppliers: [],
  createdProducts: ['A-1'],
  pendingRemovalRequests: 0,
  costMismatches: [],
  errorCode: null,
};

describe('staff product views', () => {
  it('the staff product has the piece unit, a common name and a category, and stays strict', () => {
    const product = {
      id,
      productCode: 'A-1',
      name: 'A-1',
      unit: 'PIECE',
      category: null,
      categoryId: null,
      trackingType: 'NONE',
      markingRequired: false,
      codeRuleConfigured: false,
      isActive: true,
      codeGenerated: false,
      mergedIntoProductId: null,
      translations: [],
      createdAt: at,
      updatedAt: at,
    };
    expect(staffProductDetailResponseSchema.safeParse(product).success).toBe(true);
    expect(staffProductDetailResponseSchema.safeParse({ ...product, margin: '1' }).success).toBe(
      false,
    );
    expect(staffProductDetailResponseSchema.safeParse({ ...product, unit: null }).success).toBe(
      false,
    );
  });

  it('queries are strict and trimmed; inStock is a boolean', () => {
    expect(staffProductDetailListQuerySchema.parse({ category: ' Phones ' }).category).toBe(
      'Phones',
    );
    expect(unpricedProductsQuerySchema.safeParse({ category: '' }).success).toBe(false);
    expect(unpricedProductsQuerySchema.safeParse({ foo: 'x' }).success).toBe(false);
    expect(stockOverviewQuerySchema.parse({ inStock: 'true' }).inStock).toBe(true);
    expect(stockOverviewQuerySchema.parse({ inStock: 'false' }).inStock).toBe(false);
    expect(stockOverviewQuerySchema.parse({}).inStock).toBeUndefined();
    expect(stockOverviewQuerySchema.safeParse({ inStock: 'yes' }).success).toBe(false);
    expect(unpricedProductsQuerySchema.parse({ limit: '50', cursor: 'abc' }).limit).toBe(50);
    for (const limit of ['0', '201', '1.5', 'x']) {
      expect(stockOverviewQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(stockOverviewQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('unpriced and stock responses are strict', () => {
    const item = {
      productId: id,
      productCode: 'A-1',
      names: [{ lang: 'RU', name: 'Товар' }],
      unit: 'PIECE',
      isActive: true,
      category: 'Phones',
      stockQuantity: '1.000',
      latestDelivery: { deliveredAt: at, supplier: 's', costUsd: '1.0000', costUzs: '12650.00' },
      imageUrl: `/api/media/product-images/${id}/thumb`,
      imageLargeUrl: `/api/media/product-images/${id}/large`,
    };
    const unpriced = {
      items: [{ ...item, hasDraftPrice: false }],
      categories: [{ category: 'Phones', count: 1 }],
      uncategorizedCount: 0,
      nextCursor: null,
      total: 1,
    };
    expect(unpricedProductsResponseSchema.safeParse(unpriced).success).toBe(true);
    expect(
      unpricedProductsResponseSchema.safeParse({ ...unpriced, nextCursor: 'abc' }).success,
    ).toBe(true);
    // Paging fields are required in the response: a client never has to guess.
    expect(
      unpricedProductsResponseSchema.safeParse({ ...unpriced, total: undefined }).success,
    ).toBe(false);
    expect(
      unpricedProductsResponseSchema.safeParse({
        ...unpriced,
        items: [{ ...unpriced.items[0], purchasePrice: '1' }],
      }).success,
    ).toBe(false);
    const stock = {
      items: [
        {
          ...item,
          heldQuantity: '0.000',
          availableQuantity: '1.000',
          isPriced: true,
          deliveryCount: 2,
          suppliers: ['alpha trade import'],
        },
      ],
      categories: [],
      uncategorizedCount: 0,
      nextCursor: null,
      total: 1,
    };
    expect(stockOverviewResponseSchema.safeParse(stock).success).toBe(true);
    // The photo fields are required (null without a primary photo).
    const { imageUrl: _thumb, ...withoutPhoto } = item;
    void _thumb;
    expect(
      stockOverviewResponseSchema.safeParse({
        ...stock,
        items: [
          {
            ...withoutPhoto,
            imageUrl: null,
            imageLargeUrl: null,
            heldQuantity: '0.000',
            availableQuantity: '1.000',
            isPriced: true,
            deliveryCount: 2,
            suppliers: [],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      stockOverviewResponseSchema.safeParse({
        ...stock,
        items: [{ ...withoutPhoto, isPriced: true, deliveryCount: 2 }],
      }).success,
    ).toBe(false);
    expect(
      stockOverviewResponseSchema.safeParse({
        ...stock,
        items: [{ ...stock.items[0], stockQuantity: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it('keeps all of it out of the package barrel (customer bundle)', () => {
    for (const name of [
      'staffProductDetailResponseSchema',
      'unpricedProductsResponseSchema',
      'stockOverviewResponseSchema',
      'sheetSyncRunSchema',
    ]) {
      expect(Object.keys(staffCost), name).toContain(name);
      expect(Object.keys(shared), name).not.toContain(name);
    }
  });

  it('has staff routes', () => {
    expect(COST_ROUTES.unpricedProducts).toEqual({
      method: 'GET',
      path: '/staff/products/unpriced',
    });
    expect(COST_ROUTES.stockOverview.path).toBe('/staff/stock');
    expect(COST_ROUTES.sheetSyncRuns.path).toBe('/staff/sheet-sync/runs');
    expect(COST_ROUTES.lastSheetSyncRun.path).toBe('/staff/sheet-sync/runs/last');
  });
});

describe('sheet sync run contract', () => {
  it('parses a run and refuses extra keys (no room for cost values)', () => {
    expect(sheetSyncRunSchema.safeParse(run).success).toBe(true);
    expect(sheetSyncRunSchema.safeParse({ ...run, errorMessage: 'x' }).success).toBe(false);
    expect(
      sheetSyncRunSchema.safeParse({
        ...run,
        rejectedRows: [{ header: 'h', reason: 'r', costUsd: '1' }],
      }).success,
    ).toBe(false);
  });

  it('an error code exists exactly for a FAILED run', () => {
    expect(sheetSyncRunSchema.safeParse({ ...run, status: 'FAILED' }).success).toBe(false);
    expect(sheetSyncRunSchema.safeParse({ ...run, errorCode: 'X' }).success).toBe(false);
    expect(
      sheetSyncRunSchema.safeParse({ ...run, status: 'FAILED', errorCode: 'SYNC_FAILED' }).success,
    ).toBe(true);
  });

  it('limits the list: default 20, at most 50', () => {
    expect(sheetSyncRunsQuerySchema.parse({}).limit).toBe(20);
    expect(sheetSyncRunsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    for (const limit of ['0', '51', '1.5', 'abc']) {
      expect(sheetSyncRunsQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });
});
