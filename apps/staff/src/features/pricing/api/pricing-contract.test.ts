import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '@core/lib/http-client';
import { createHttpPricingApi } from './pricing-api';

// CONTRACT test. The payloads below are literal copies of what the API sends (the integration
// tests of apps/api/src/modules/pricing pin the same shapes): every staff price list response
// carries `usdRateSnapshot` (null when no rate existed at publish time). If the API contract
// moves, this test must be updated together with the schemas the web parses with.
const ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';

const SNAPSHOT = { rate: '12650.0000', source: 'CBU', rateDate: '2026-10-19' };
const PUBLISHED = {
  id: ID,
  number: 15,
  status: 'PUBLISHED',
  note: null,
  source: 'MANUAL',
  createdAt: '2026-10-19T05:00:00.000Z',
  publishedAt: '2026-10-19T08:30:00.000Z',
  publishedBy: 'Aziza Y.',
  publishedByUserId: '00000000-0000-7000-8000-00000000a001',
  usdRateSnapshot: SNAPSHOT,
};
const ARCHIVED = {
  ...PUBLISHED,
  number: 14,
  status: 'ARCHIVED',
  usdRateSnapshot: null,
};
const ITEM = {
  productId: PRODUCT,
  productCode: 'KAB-1',
  unit: 'dona',
  isActive: true,
  codeGenerated: false,
  sheetMatch: null,
  names: [{ lang: 'UZ', name: 'Kabel' }],
  basePrice: '12.50',
  deferredPrice: null,
  rrp: '15.90',
  wholesalePrice: null,
  wholesaleDeferredPrice: null,
  alifPrice: null,
  alifDeferredPrice: null,
  currency: 'USD',
  uzs: { basePrice: '158125.00', deferredPrice: null },
  imageUrl: '/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/thumb',
  imageLargeUrl: '/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/large',
};

function apiFor(body: unknown) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  return createHttpPricingApi(createHttpClient({ baseUrl: 'https://api.test', fetchImpl }));
}

describe('pricing API contract: staff responses carry usdRateSnapshot', () => {
  it('parses the current list and a version detail', async () => {
    const body = { version: PUBLISHED, items: [ITEM] };
    expect((await apiFor(body).getCurrent()).version.usdRateSnapshot).toEqual(SNAPSHOT);
    expect((await apiFor(body).getVersion(ID)).items).toHaveLength(1);
  });

  it('parses the version list (summaries carry itemCount and the snapshot)', async () => {
    const body = {
      items: [
        { ...PUBLISHED, itemCount: 12 },
        { ...ARCHIVED, itemCount: 3 },
      ],
    };
    const list = await apiFor(body).listVersions();
    expect(list.items[0]?.usdRateSnapshot).toEqual(SNAPSHOT);
    expect(list.items[1]?.usdRateSnapshot).toBeNull();
  });

  it('parses the result of publishing changes (the new version plus skippedInactiveCount)', async () => {
    const result = await apiFor({ ...PUBLISHED, skippedInactiveCount: 1 }).publishChanges({
      baseVersionNumber: 14,
      upserts: [{ productId: PRODUCT, basePrice: '1500.00', deferredPrice: null, rrp: null }],
      removedProductIds: [],
    });
    expect(result).toMatchObject({ number: 15, status: 'PUBLISHED', skippedInactiveCount: 1 });
    expect(result.usdRateSnapshot).toEqual(SNAPSHOT);
  });
});
