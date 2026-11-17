import { describe, expect, it, vi } from 'vitest';
import { InvalidResponseError } from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { createHttpCostApi } from './cost-api';
import { createHttpStockApi } from './stock-api';

// CONTRACT test. The payloads are shaped like the real API answers (the api's integration tests
// pin the same shapes): strings for every decimal, strict objects, staff-only fields. If the API
// moves, update these together with the shared schemas the web parses with.
const PRODUCT = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';

const DELIVERY = {
  deliveryRef: 'Z-20413',
  supplier: 'alpha trade import',
  purchaseMethod: 'Import',
  category: 'Telefonlar',
  deliveredQuantity: '40.000',
  availableQuantity: '34.000',
  costUsd: '133.5000',
  usdRateUsed: '12650.0000',
  costUzs: '1688775.00',
  deliveredAt: '2026-10-16T05:00:00.000Z',
  syncedAt: '2026-10-19T04:00:00.000Z',
};
const SUMMARY = {
  deliveredAt: DELIVERY.deliveredAt,
  deliveryRef: DELIVERY.deliveryRef,
  supplier: DELIVERY.supplier,
  costUsd: DELIVERY.costUsd,
  usdRateUsed: DELIVERY.usdRateUsed,
  costUzs: DELIVERY.costUzs,
};
const RATE = {
  rate: '12650.0000',
  updatedAt: '2026-10-19T04:00:00.000Z',
  updatedBy: null,
  updatedByUserId: null,
  source: 'CBU',
  rateDate: '2026-10-19',
  followsCentralBank: true,
  manualRate: null,
  manualExpiresAt: null,
  lastRefreshFailedAt: null,
  lastChannelFailedAt: null,
};
const LATEST = {
  deliveredAt: DELIVERY.deliveredAt,
  supplier: DELIVERY.supplier,
  costUsd: DELIVERY.costUsd,
  costUzs: DELIVERY.costUzs,
};
const RUN = {
  id: '55555555-5555-4555-8555-555555555555',
  startedAt: '2026-10-19T04:00:00.000Z',
  finishedAt: '2026-10-19T04:00:09.000Z',
  status: 'OK',
  trigger: 'MANUAL',
  counts: {
    rowsRead: 212,
    created: 3,
    updated: 1,
    unchanged: 190,
    rejected: 2,
    skippedRows: 15,
    staleRefs: 0,
    mismatches: 1,
    createdProducts: 2,
    removalsRequested: 1,
    removalsDismissed: 0,
    reappearedAfterRemoval: 0,
  },
  rejectedRows: [{ header: 'Цена закупа $', reason: 'NOT_A_NUMBER', productCode: '10523' }],
  skippedSuppliers: [
    {
      supplier: 'Beta system tm fbs',
      reason: 'BEFORE_DATE_LIMIT',
      count: 12,
      hasInvisibleCharacters: false,
    },
  ],
  createdProducts: ['10521', '10522'],
  pendingRemovalRequests: 1,
  costMismatches: [{ productCode: '10482', deliveryRef: 'Z-20413', differencePercent: '0.80' }],
  errorCode: null,
};

function stubs(body: unknown, status = 200) {
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, cost: createHttpCostApi(http), stock: createHttpStockApi(http) };
}

describe('cost API contract', () => {
  it('parses the cost list of the current price list', async () => {
    const { cost, fetchImpl } = stubs({
      versionNumber: 14,
      items: [
        {
          productId: PRODUCT,
          latest: SUMMARY,
          recent: [SUMMARY],
          stockQuantity: '34.000',
          suppliers: ['alpha trade import'],
        },
        { productId: REQUEST, latest: null, recent: [], stockQuantity: null, suppliers: [] },
      ],
    });
    const costs = await cost.getPriceListCosts();
    expect(costs.items[0]?.recent[0]?.costUzs).toBe('1688775.00');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.test/staff/price-list/current/costs');
  });

  it('parses the full delivery history of a product', async () => {
    const { cost, fetchImpl } = stubs({
      productId: PRODUCT,
      productCode: '10482',
      latest: DELIVERY,
      deliveries: [DELIVERY],
    });
    expect((await cost.getProductCostReference(PRODUCT)).deliveries).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.test/staff/products/${PRODUCT}/cost-reference`,
    );
  });

  it('parses the USD rate (also the empty state) and sends PUT / POST for changes', async () => {
    expect((await stubs(RATE).cost.getUsdRate()).source).toBe('CBU');
    const empty = {
      ...RATE,
      rate: null,
      updatedAt: null,
      source: null,
      rateDate: null,
    };
    expect((await stubs(empty).cost.getUsdRate()).rate).toBeNull();

    const put = stubs({ ...RATE, source: 'MANUAL', updatedBy: 'Aziza Y.' });
    await put.cost.setUsdRate({ rate: '12700' });
    const init = put.fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe('{"rate":"12700"}');

    const follow = stubs(RATE);
    await follow.cost.followCentralBank();
    expect(follow.fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(follow.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.test/staff/usd-rate/follow-central-bank',
    );
  });

  it('rejects a response with a float cost or an unknown field (strict parsing)', async () => {
    const floaty = {
      versionNumber: 1,
      items: [
        {
          productId: PRODUCT,
          latest: { ...SUMMARY, costUsd: 133.5 },
          recent: [],
          stockQuantity: null,
        },
      ],
    };
    await expect(stubs(floaty).cost.getPriceListCosts()).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
    await expect(stubs({ ...RATE, margin: '1.2' }).cost.getUsdRate()).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });
});

describe('stock API contract', () => {
  const NAMES = [
    { lang: 'UZ', name: 'Samsung Galaxy A15 4/128GB' },
    { lang: 'RU', name: 'Samsung Galaxy A15 4/128GB' },
  ];

  it('parses the unpriced list and sends the filters as a query string', async () => {
    const { stock, fetchImpl } = stubs({
      items: [
        {
          productId: PRODUCT,
          productCode: '10521',
          names: NAMES,
          unit: 'PIECE',
          isActive: true,
          category: 'Telefonlar',
          stockQuantity: '12.000',
          latestDelivery: LATEST,
          hasDraftPrice: false,
          imageUrl: null,
          imageLargeUrl: null,
        },
      ],
      categories: [{ category: 'Telefonlar', count: 1 }],
      uncategorizedCount: 0,
      nextCursor: null,
      total: 1,
    });
    const result = await stock.listUnpriced({ category: 'Telefonlar', search: '105' });
    expect(result.items[0]?.unit).toBe('PIECE');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.test/staff/products/unpriced?category=Telefonlar&search=105',
    );
  });

  it('parses the stock overview and sends inStock as true / false', async () => {
    const { stock, fetchImpl } = stubs({
      items: [
        {
          productId: PRODUCT,
          productCode: '10482',
          names: NAMES,
          unit: 'PIECE',
          isActive: true,
          category: null,
          stockQuantity: null,
          heldQuantity: '0.000',
          availableQuantity: null,
          isPriced: true,
          latestDelivery: null,
          deliveryCount: 0,
          suppliers: [],
          imageUrl: '/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/thumb',
          imageLargeUrl: '/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/large',
        },
      ],
      categories: [],
      uncategorizedCount: 1,
      nextCursor: null,
      total: 1,
    });
    await stock.listStock({ inStock: false });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.test/staff/stock?inStock=false');
  });

  it('parses sync runs, the last run and treats 404 as "never ran"', async () => {
    expect((await stubs({ items: [RUN] }).stock.listSyncRuns(5)).items[0]?.counts.rowsRead).toBe(
      212,
    );
    expect((await stubs(RUN).stock.getLastSyncRun())?.status).toBe('OK');
    const notFound = { error: { code: 'NOT_FOUND', message: 'No sync run yet' } };
    expect(await stubs(notFound, 404).stock.getLastSyncRun()).toBeNull();
  });

  it('rejects a failed run without an error code', async () => {
    await expect(stubs({ ...RUN, status: 'FAILED' }).stock.getLastSyncRun()).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it('parses removal requests and decisions', async () => {
    const line = {
      deliveredAt: DELIVERY.deliveredAt,
      supplier: DELIVERY.supplier,
      deliveredQuantity: '40.000',
      availableQuantity: '34.000',
      costUsd: '133.5000',
      usdRateUsed: '12650.0000',
      costUzs: '1688775.00',
    };
    const list = stubs({
      total: 1,
      items: [
        {
          id: REQUEST,
          productId: PRODUCT,
          productCode: '10482',
          deliveryRef: 'Z-20413',
          detectedAt: '2026-10-19T04:00:00.000Z',
          line,
        },
      ],
    });
    expect((await list.stock.listSupplyRemovals()).total).toBe(1);

    const decided = stubs({
      id: REQUEST,
      status: 'CONFIRMED',
      decidedAt: '2026-10-19T05:00:00.000Z',
      decidedBy: 'Aziza Y.',
    });
    expect((await decided.stock.confirmSupplyRemoval(REQUEST)).status).toBe('CONFIRMED');
    expect(decided.fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.test/staff/supply-removals/${REQUEST}/confirm`,
    );
    const dismissed = stubs({
      ...{ id: REQUEST, decidedAt: RUN.finishedAt, decidedBy: null },
      status: 'DISMISSED',
    });
    await dismissed.stock.dismissSupplyRemoval(REQUEST);
    expect(dismissed.fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.test/staff/supply-removals/${REQUEST}/dismiss`,
    );
  });
});
