import { describe, expect, it } from 'vitest';
import {
  buildPath,
  customerPriceListResponseSchema,
  staffVersionResponseSchema,
} from '../index.js';
import * as shared from '../index.js';
import {
  COST_ROUTES,
  STAFF_ONLY_COST_SCHEMAS,
  RECENT_DELIVERIES_LIMIT,
  costDeliverySchema,
  costDeliverySummarySchema,
  priceListCostItemSchema,
  priceListCostsResponseSchema,
  productCostReferenceResponseSchema,
  updateUsdRateRequestSchema,
  staffVersionWithRateResponseSchema,
  supplyRemovalDecisionResponseSchema,
  supplyRemovalListResponseSchema,
  supplyRemovalRequestSchema,
  usdRateResponseSchema,
  usdRateSnapshotSchema,
  usdRateStringSchema,
} from '../staff-cost.js';
import * as staffCost from '../staff-cost.js';

const id = '019a0000-0000-7000-8000-000000000001';
const at = '2026-10-20T08:00:00.000Z';
const delivery = {
  deliveryRef: 'REQ-027',
  supplier: 'alpha trade import',
  purchaseMethod: 'Безнал',
  category: 'Смартфоны',
  deliveredQuantity: '1000.125',
  availableQuantity: '250.500',
  costUsd: '12.3456',
  usdRateUsed: '12650.5000',
  costUzs: '156190.50',
  deliveredAt: at,
  syncedAt: at,
};

const unset = {
  rate: null,
  updatedAt: null,
  updatedBy: null,
  updatedByUserId: null,
  source: null,
  rateDate: null,
  followsCentralBank: true,
  manualRate: null,
  manualExpiresAt: null,
  lastRefreshFailedAt: null,
  lastChannelFailedAt: null,
};

describe('usd rate contract', () => {
  it.each(['1', '12650.5', '12650.5000', '0.0001', '99999999999999.9999'])('accepts %s', (v) => {
    expect(usdRateStringSchema.safeParse(v).success).toBe(true);
  });

  it.each([12650.5, null, '0', '0.0000', '-1', '1.23456', '1e4', '', ' 5', '1,5', '007'])(
    'rejects %j',
    (v) => {
      expect(usdRateStringSchema.safeParse(v).success).toBe(false);
    },
  );

  it('request is strict, response allows an unset rate', () => {
    expect(updateUsdRateRequestSchema.safeParse({ rate: '12650.50' }).success).toBe(true);
    expect(updateUsdRateRequestSchema.safeParse({ rate: '12650.50', x: 1 }).success).toBe(false);
    expect(usdRateResponseSchema.safeParse(unset).success).toBe(true);
  });

  it('the response carries source, rate date, follow flag and a refresh-failure flag', () => {
    const cbu = {
      rate: '12044.7200',
      updatedAt: '2026-10-20T08:00:00.000Z',
      updatedBy: null,
      updatedByUserId: null,
      source: 'CBU',
      rateDate: '2026-10-20',
      followsCentralBank: true,
      manualRate: null,
      manualExpiresAt: null,
      lastRefreshFailedAt: null,
      lastChannelFailedAt: null,
    };
    expect(usdRateResponseSchema.safeParse(cbu).success).toBe(true);
    expect(
      usdRateResponseSchema.safeParse({
        ...cbu,
        source: 'MANUAL',
        rateDate: null,
        updatedBy: 'Aziza Y.',
        updatedByUserId: '00000000-0000-7000-8000-000000000001',
        followsCentralBank: false,
        manualRate: '12650.5000',
        manualExpiresAt: '2026-10-21T09:00:00.000Z',
        lastRefreshFailedAt: '2026-10-20T09:00:00.000Z',
        lastChannelFailedAt: '2026-10-20T09:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(usdRateResponseSchema.safeParse({ ...cbu, source: 'ECB' }).success).toBe(false);
    expect(usdRateResponseSchema.safeParse({ ...cbu, rateDate: '20.10.2026' }).success).toBe(false);
    expect(usdRateResponseSchema.safeParse({ ...cbu, message: 'Bank down' }).success).toBe(false);
    expect(usdRateResponseSchema.safeParse({ ...cbu, followsCentralBank: undefined }).success).toBe(
      false,
    );
  });

  it('has a follow-central-bank route', () => {
    expect(COST_ROUTES.followCentralBank).toEqual({
      method: 'POST',
      path: '/staff/usd-rate/follow-central-bank',
    });
  });
});

describe('cost reference contract', () => {
  it('parses a product reference with latest and deliveries', () => {
    const body = { productId: id, productCode: 'KB-15', latest: delivery, deliveries: [delivery] };
    expect(productCostReferenceResponseSchema.safeParse(body).success).toBe(true);
    expect(
      productCostReferenceResponseSchema.safeParse({ ...body, latest: null, deliveries: [] })
        .success,
    ).toBe(true);
  });

  it('is strict and keeps decimals as fixed-scale strings', () => {
    expect(costDeliverySchema.safeParse({ ...delivery, margin: '5.00' }).success).toBe(false);
    expect(costDeliverySchema.safeParse({ ...delivery, costUsd: 12.3456 }).success).toBe(false);
    expect(costDeliverySchema.safeParse({ ...delivery, costUzs: '156190.5' }).success).toBe(false);
  });

  it('routes build and are staff paths', () => {
    expect(buildPath(COST_ROUTES.productCostReference, { id })).toBe(
      `/staff/products/${id}/cost-reference`,
    );
    for (const r of Object.values(COST_ROUTES)) expect(r.path.startsWith('/staff/')).toBe(true);
  });
});

describe('cost schemas stay out of customer contracts', () => {
  it('the allow-list names exist as exports of the staff-cost entry only', () => {
    for (const name of STAFF_ONLY_COST_SCHEMAS) {
      expect(Object.keys(staffCost), name).toContain(name);
      expect(Object.keys(shared), `${name} must not be in the barrel`).not.toContain(name);
    }
    expect(Object.keys(shared)).not.toContain('COST_ROUTES');
  });

  it('the customer price list rejects a cost reference smuggled into it', () => {
    const customer = {
      version: { number: 1, publishedAt: at },
      items: [
        {
          productId: id,
          productCode: 'KB-15',
          unit: 'box',
          name: 'x',
          price: '10.00',
          currency: 'UZS',
          latest: delivery,
        },
      ],
    };
    expect(customerPriceListResponseSchema.safeParse(customer).success).toBe(false);
  });
});

const summary = {
  deliveredAt: at,
  deliveryRef: 'REQ-027',
  supplier: 'alpha trade import',
  costUsd: '12.3456',
  usdRateUsed: '12650.5000',
  costUzs: '156190.50',
};
const productId = '019a0000-0000-7000-8000-000000000001';

describe('delivery lines carry supplier, purchase method and category (staff-only)', () => {
  it('requires all three, non-optional', () => {
    expect(costDeliverySchema.safeParse(delivery).success).toBe(true);
    for (const field of ['supplier', 'purchaseMethod', 'category'] as const) {
      const { [field]: _removed, ...without } = delivery;
      void _removed;
      expect(costDeliverySchema.safeParse(without).success, field).toBe(false);
    }
  });
});

describe('price list costs contract (GET /staff/price-list/current/costs)', () => {
  it('parses latest, recent (max ${RECENT_DELIVERIES_LIMIT}) and the stock aggregate', () => {
    expect(costDeliverySummarySchema.safeParse(summary).success).toBe(true);
    const item = {
      productId,
      latest: summary,
      recent: [summary],
      stockQuantity: '312.500',
      suppliers: ['alpha trade import'],
    };
    expect(priceListCostItemSchema.safeParse(item).success).toBe(true);
    expect(
      priceListCostsResponseSchema.safeParse({ versionNumber: 3, items: [item] }).success,
    ).toBe(true);
    expect(
      priceListCostItemSchema.safeParse({
        productId,
        latest: null,
        recent: [],
        stockQuantity: null,
        suppliers: [],
      }).success,
    ).toBe(true);
  });

  it('allows at most 5 recent deliveries', () => {
    const six = Array.from({ length: RECENT_DELIVERIES_LIMIT + 1 }, () => summary);
    expect(RECENT_DELIVERIES_LIMIT).toBe(5);
    expect(
      priceListCostItemSchema.safeParse({
        productId,
        latest: summary,
        recent: six,
        stockQuantity: null,
        suppliers: [],
      }).success,
    ).toBe(false);
  });

  it('is strict: extra fields, numeric money and a malformed stock quantity fail', () => {
    expect(costDeliverySummarySchema.safeParse({ ...summary, purchaseMethod: 'x' }).success).toBe(
      false,
    );
    expect(costDeliverySummarySchema.safeParse({ ...summary, costUsd: 12.3456 }).success).toBe(
      false,
    );
    const base = { productId, latest: null, recent: [], suppliers: [] };
    expect(priceListCostItemSchema.safeParse({ ...base, stockQuantity: '312.5' }).success).toBe(
      false,
    );
    expect(priceListCostItemSchema.safeParse({ ...base, stockQuantity: 312.5 }).success).toBe(
      false,
    );
    expect(priceListCostItemSchema.safeParse({ ...base }).success).toBe(false);
  });

  it('has a staff route and lives only in the staff-cost entry', () => {
    expect(COST_ROUTES.currentPriceListCosts).toEqual({
      method: 'GET',
      path: '/staff/price-list/current/costs',
    });
    expect(Object.keys(shared)).not.toContain('priceListCostsResponseSchema');
  });
});

describe('staff version DTOs with the USD rate snapshot (staff-cost only)', () => {
  const version = {
    id: '019a0000-0000-7000-8000-000000000001',
    number: 3,
    status: 'PUBLISHED',
    note: null,
    source: 'MANUAL',
    createdAt: at,
    publishedAt: at,
    publishedBy: 'Aziza Y.',
    publishedByUserId: '00000000-0000-7000-8000-000000000001',
  };
  const snapshot = { rate: '12650.5000', source: 'MANUAL', rateDate: null };

  it('carries the snapshot or an explicit null (no rate at publish time)', () => {
    expect(
      staffVersionWithRateResponseSchema.safeParse({ ...version, usdRateSnapshot: snapshot })
        .success,
    ).toBe(true);
    expect(
      staffVersionWithRateResponseSchema.safeParse({ ...version, usdRateSnapshot: null }).success,
    ).toBe(true);
    expect(staffVersionWithRateResponseSchema.safeParse(version).success).toBe(false);
  });

  it('is strict: a numeric rate, an unknown source and a malformed date fail', () => {
    for (const bad of [
      { ...snapshot, rate: 12650.5 },
      { ...snapshot, rate: '12650.5' },
      { ...snapshot, source: 'ECB' },
      { ...snapshot, rateDate: '20.10.2026' },
      { ...snapshot, extra: 1 },
    ]) {
      expect(usdRateSnapshotSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('the plain barrel version DTO rejects the snapshot; the barrel never exports it', () => {
    expect(
      staffVersionResponseSchema.safeParse({ ...version, usdRateSnapshot: snapshot }).success,
    ).toBe(false);
    expect(Object.keys(shared)).not.toContain('usdRateSnapshotSchema');
  });
});

describe('supply removal contract', () => {
  const id = '019a0000-0000-7000-8000-000000000001';
  const request = {
    id,
    productId: id,
    productCode: '10482',
    deliveryRef: 'REQ-014',
    detectedAt: at,
    line: {
      deliveredAt: at,
      supplier: 'alpha trade import',
      deliveredQuantity: '35.000',
      availableQuantity: '12.000',
      costUsd: '12.3400',
      usdRateUsed: '12650.0000',
      costUzs: '156101.00',
    },
  };

  it('parses a pending list with its total, and an empty one', () => {
    expect(supplyRemovalRequestSchema.safeParse(request).success).toBe(true);
    expect(supplyRemovalListResponseSchema.safeParse({ total: 1, items: [request] }).success).toBe(
      true,
    );
    expect(supplyRemovalListResponseSchema.safeParse({ total: 0, items: [] }).success).toBe(true);
    expect(supplyRemovalListResponseSchema.safeParse({ items: [] }).success).toBe(false);
    expect(supplyRemovalListResponseSchema.safeParse({ total: -1, items: [] }).success).toBe(false);
  });

  it('is strict and keeps money as fixed-scale strings', () => {
    expect(supplyRemovalRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(
      supplyRemovalRequestSchema.safeParse({
        ...request,
        line: { ...request.line, costUsd: 12.34 },
      }).success,
    ).toBe(false);
    expect(
      supplyRemovalRequestSchema.safeParse({ ...request, line: { ...request.line, margin: '1' } })
        .success,
    ).toBe(false);
  });

  it('a decision is CONFIRMED or DISMISSED with a time and a nullable actor', () => {
    for (const status of ['CONFIRMED', 'DISMISSED']) {
      expect(
        supplyRemovalDecisionResponseSchema.safeParse({
          id,
          status,
          decidedAt: at,
          decidedBy: null,
        }).success,
      ).toBe(true);
    }
    expect(
      supplyRemovalDecisionResponseSchema.safeParse({
        id,
        status: 'PENDING',
        decidedAt: at,
        decidedBy: 'u',
      }).success,
    ).toBe(false);
  });

  it('has staff routes: a list and two decisions', () => {
    expect(COST_ROUTES.listSupplyRemovals).toEqual({
      method: 'GET',
      path: '/staff/supply-removals',
    });
    expect(buildPath(COST_ROUTES.confirmSupplyRemoval, { id })).toBe(
      `/staff/supply-removals/${id}/confirm`,
    );
    expect(buildPath(COST_ROUTES.dismissSupplyRemoval, { id })).toBe(
      `/staff/supply-removals/${id}/dismiss`,
    );
  });
});
