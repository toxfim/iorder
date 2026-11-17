import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GENERATED_PRODUCT_CODE_PATTERN,
  cartLineSchema,
  cartResponseSchema,
  customerGoodsListSchema,
  customerGoodsProductSchema,
  customerGoodsSummarySchema,
  customerGoodsUnitSchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerPriceListResponseSchema,
  customerTimelineResponseSchema,
  formatGeneratedProductCode,
  hasGeneratedProductCodePrefix,
  productCodeSchema,
} from '../index.js';
import {
  BY_ORDER_OPEN_STATUSES,
  MANUAL_PRODUCT_ROUTES,
  PRICE_IMPORT_COLUMNS,
  PRICE_IMPORT_MAX_ROWS,
  PRODUCT_CATEGORY_MAX_LENGTH,
  byOrderOpenOrderSchema,
  byOrderProductSchema,
  byOrderProductsResponseSchema,
  createManualProductRequestSchema,
  priceImportConfirmRequestSchema,
  priceImportPreviewRowSchema,
} from '../staff-cost.js';

const UUID = '0193a5f0-7d6e-7a1b-9c2d-3e4f5a6b7c8d';

describe('generated product codes (staff-added products without a sheet Товар_ID)', () => {
  it('formats the sequence number with the reserved prefix and 6 digits', () => {
    expect(formatGeneratedProductCode(1)).toBe('IO-000001');
    expect(formatGeneratedProductCode(123)).toBe('IO-000123');
    expect(formatGeneratedProductCode(1234567)).toBe('IO-1234567');
    expect(() => formatGeneratedProductCode(0)).toThrow(RangeError);
    expect(() => formatGeneratedProductCode(1.5)).toThrow(RangeError);
  });

  it('a generated code passes the product code rule, so it is stored like any other code', () => {
    expect(productCodeSchema.safeParse(formatGeneratedProductCode(42)).success).toBe(true);
    expect(GENERATED_PRODUCT_CODE_PATTERN.test('IO-000042')).toBe(true);
    expect(GENERATED_PRODUCT_CODE_PATTERN.test('IO-42')).toBe(false);
  });

  it('recognises the reserved prefix ignoring case, like every code comparison', () => {
    expect(hasGeneratedProductCodePrefix('IO-000001')).toBe(true);
    expect(hasGeneratedProductCodePrefix(' io-7 ')).toBe(true);
    expect(hasGeneratedProductCodePrefix('40919')).toBe(false);
    expect(hasGeneratedProductCodePrefix('HONOR-X7C')).toBe(false);
  });
});

describe('manual product requests', () => {
  it('a product needs a name and a sale price; brand and deferred price default to none', () => {
    expect(
      createManualProductRequestSchema.parse({
        baseVersionNumber: 3,
        name: '  Anker kabel  ',
        basePrice: '12.50',
      }),
    ).toEqual({
      baseVersionNumber: 3,
      name: 'Anker kabel',
      brandId: null,
      category: null,
      basePrice: '12.50',
      deferredPrice: null,
    });
    expect(
      createManualProductRequestSchema.safeParse({
        baseVersionNumber: null,
        name: '',
        basePrice: '1',
      }).success,
    ).toBe(false);
    // A cost-like field is a validation error, never silently accepted (strict).
    expect(
      createManualProductRequestSchema.safeParse({
        baseVersionNumber: null,
        name: 'x',
        basePrice: '1',
        cost: '0.5',
      }).success,
    ).toBe(false);
  });

  it('a confirm names each product code once (ignoring case) and has at most the row limit', () => {
    const row = { productCode: 'IO-000001', name: 'A', basePrice: '1' };
    expect(
      priceImportConfirmRequestSchema.safeParse({
        baseVersionNumber: null,
        rows: [row, { ...row, productCode: 'io-000001' }],
      }).success,
    ).toBe(false);
    expect(
      priceImportConfirmRequestSchema.safeParse({
        baseVersionNumber: null,
        rows: [row, { ...row, productCode: null }, { ...row, productCode: null }],
      }).success,
    ).toBe(true);
    expect(
      priceImportConfirmRequestSchema.safeParse({
        baseVersionNumber: null,
        rows: Array.from({ length: PRICE_IMPORT_MAX_ROWS + 1 }, () => ({
          ...row,
          productCode: null,
        })),
      }).success,
    ).toBe(false);
  });

  it('an import row may carry a category and an RRP; both default to none', () => {
    const parsed = priceImportConfirmRequestSchema.parse({
      baseVersionNumber: 4,
      rows: [
        { productCode: null, name: 'A', basePrice: '1' },
        { productCode: null, name: 'B', basePrice: '1', category: '  Kabellar  ', rrp: '1.50' },
      ],
    });
    expect(parsed.rows.map(({ category, rrp }) => ({ category, rrp }))).toEqual([
      { category: null, rrp: null },
      { category: 'Kabellar', rrp: '1.50' },
    ]);
    const row = { productCode: null, name: 'A', basePrice: '1' };
    for (const extra of [
      { category: '' },
      { category: 'x'.repeat(PRODUCT_CATEGORY_MAX_LENGTH + 1) },
      { rrp: 1.5 },
      { rrp: '0' },
    ]) {
      expect(
        priceImportConfirmRequestSchema.safeParse({
          baseVersionNumber: null,
          rows: [{ ...row, ...extra }],
        }).success,
      ).toBe(false);
    }
  });

  it('the template has seven columns: category after the brand, the RRP last', () => {
    expect(PRICE_IMPORT_COLUMNS).toEqual([
      'productCode',
      'name',
      'brand',
      'category',
      'basePrice',
      'deferredPrice',
      'rrp',
    ]);
  });

  it('a preview row carries the verdict codes the UI translates', () => {
    expect(
      priceImportPreviewRowSchema.safeParse({
        rowNumber: 2,
        productCode: null,
        productId: null,
        codeGenerated: null,
        name: 'Yangi tovar',
        brandName: 'Anker',
        category: 'Kabellar',
        basePrice: '10.00',
        deferredPrice: null,
        rrp: '14.90',
        currentBasePrice: null,
        currentDeferredPrice: null,
        currentRrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        wholesaleGiven: false,
        alifPrice: null,
        alifDeferredPrice: null,
        alifGiven: false,
        currentWholesalePrice: null,
        currentWholesaleDeferredPrice: null,
        currentAlifPrice: null,
        currentAlifDeferredPrice: null,
        status: 'NEW',
        issues: [],
        warnings: ['CODE_WILL_BE_GENERATED'],
      }).success,
    ).toBe(true);
    expect(
      priceImportPreviewRowSchema.safeParse({
        rowNumber: 3,
        productCode: '40919',
        productId: UUID,
        codeGenerated: false,
        name: 'Sheet tovar',
        brandName: null,
        category: null,
        basePrice: null,
        deferredPrice: null,
        rrp: null,
        currentBasePrice: '9.00',
        currentDeferredPrice: null,
        currentRrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        wholesaleGiven: false,
        alifPrice: null,
        alifDeferredPrice: null,
        alifGiven: false,
        currentWholesalePrice: null,
        currentWholesaleDeferredPrice: null,
        currentAlifPrice: null,
        currentAlifDeferredPrice: null,
        status: 'ERROR',
        issues: ['PRICE_MISSING', 'NOT_A_CODE'],
        warnings: [],
      }).success,
    ).toBe(false);
  });
});

describe('by-order products ("Buyurtma orqali", staff only)', () => {
  const order = {
    orderId: UUID,
    orderNumber: 'IO-10501',
    organizationName: 'Orion Mobile',
    status: 'SUBMITTED',
    quantity: '3.000',
    submittedAt: '2026-11-09T05:00:00.000Z',
  };
  const product = {
    productId: UUID,
    productCode: 'IO-000007',
    name: 'Quloqchin',
    brandName: null,
    category: 'Audio',
    isActive: true,
    basePrice: '2.00',
    deferredPrice: null,
    currency: 'USD',
    openQuantity: '3.000',
    openOrderCount: 1,
    orders: [order],
  };

  it('an order waits for the goods until they leave the warehouse', () => {
    expect([...BY_ORDER_OPEN_STATUSES]).toEqual([
      'SUBMITTED',
      'MANAGER_APPROVED',
      'ACCOUNTING_CLEARED',
    ]);
    for (const status of ['RELEASED', 'DELIVERED', 'RECEIVED', 'REJECTED', 'CANCELLED']) {
      expect(byOrderOpenOrderSchema.safeParse({ ...order, status }).success).toBe(false);
    }
  });

  it('a product carries its open demand; an unpriced one has no price and no currency', () => {
    expect(byOrderProductsResponseSchema.parse({ items: [product] }).items).toHaveLength(1);
    const idle = {
      ...product,
      basePrice: null,
      currency: null,
      openQuantity: '0.000',
      openOrderCount: 0,
      orders: [],
    };
    expect(byOrderProductSchema.safeParse(idle).success).toBe(true);
    expect(byOrderProductSchema.safeParse({ ...product, openQuantity: '3' }).success).toBe(false);
  });

  it('is a strict allow-list: a cost or stock key fails to parse', () => {
    for (const extra of [{ costUsd: '1.0000' }, { stockQuantity: '5.000' }, { supplier: 'ACME' }]) {
      expect(byOrderProductSchema.safeParse({ ...product, ...extra }).success).toBe(false);
    }
  });

  it('has its own route prefix, which no product id route can swallow', () => {
    expect(MANUAL_PRODUCT_ROUTES.byOrderProducts).toMatchObject({
      method: 'GET',
      path: '/staff/by-order-products',
    });
  });
});

// The customer must never learn that a product is staff-added or brought by order [C, owner
// 2026-11-09]. Every customer response schema is a strict allow-list, so a flag that is not in its
// shape cannot be sent; this pins that no such flag is in any of them, under any plausible name.
describe('customer contracts never carry the product type', () => {
  const TYPE_FLAG =
    /stockTracked|tracked|codeGenerated|generated|sheetMatch|mergedInto|byOrder|by_order|onOrder|madeToOrder|manual|origin|source/i;

  const customerSchemas = {
    customerPriceListResponseSchema,
    cartResponseSchema,
    customerOrderSchema,
    customerOrderListResponseSchema,
    customerTimelineResponseSchema,
    customerGoodsListSchema,
    customerGoodsProductSchema,
    customerGoodsUnitSchema,
    customerGoodsSummarySchema,
  };

  /** Every property name of a schema, at any depth. */
  function propertyNames(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) {
      for (const child of node) propertyNames(child, found);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'properties' && typeof child === 'object' && child !== null) {
          for (const name of Object.keys(child)) found.add(name);
        }
        propertyNames(child, found);
      }
    }
    return found;
  }

  it.each(Object.entries(customerSchemas))('%s has no such field', (_, schema) => {
    const names = [...propertyNames(z.toJSONSchema(schema))];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => TYPE_FLAG.test(name))).toEqual([]);
  });

  it('a by-order flag added to a customer line fails to parse', () => {
    const line = {
      productId: UUID,
      productCode: 'IO-000007',
      name: 'Quloqchin',
      unit: 'dona',
      quantity: '1',
      unitPrice: '24000.00',
      lineTotal: '24000.00',
      deferredUnitPrice: null,
      deferredLineTotal: null,
      rrp: null,
      // A staff-added product never has a stock figure: null, like any product without one.
      orderableStock: null,
      problem: null,
    };
    expect(cartLineSchema.safeParse(line).success).toBe(true);
    for (const leak of [{ stockTracked: false }, { codeGenerated: true }, { byOrder: true }]) {
      expect(cartLineSchema.safeParse({ ...line, ...leak }).success).toBe(false);
    }
  });
});
