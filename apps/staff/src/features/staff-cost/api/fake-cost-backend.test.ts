import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '@iorder/shared';
import {
  costDeliverySchema,
  priceListCostsResponseSchema,
  sheetSyncRunsResponseSchema,
  stockOverviewResponseSchema,
  supplyRemovalListResponseSchema,
  unpricedProductsResponseSchema,
  usdRateResponseSchema,
} from '@iorder/shared/staff-cost';
import { createFakePriceBackend } from '@/features/pricing/api/fake-price-backend';
import { ApiNotFoundError, ApiValidationError, PermissionDeniedError } from '@core/lib/api-errors';
import { createFakeCostBackend, FAKE_SYNC_DURATION_MS } from './fake-cost-backend';

const NOW = new Date('2026-10-19T04:30:00.000Z');

function setup(initial: readonly StaffRole[] = ['MANAGER']) {
  let roles: readonly StaffRole[] = initial;
  const price = createFakePriceBackend({ now: () => NOW });
  const cost = createFakeCostBackend({ view: price.view, roles: () => roles, now: () => NOW });
  return {
    price,
    ...cost,
    asRole: (next: readonly StaffRole[]) => {
      roles = next;
    },
    idOf: (code: string) => {
      const found = price.view.products().find((p) => p.productCode === code);
      if (!found) throw new Error(`no product ${code}`);
      return found.id;
    },
  };
}

describe('fake cost backend: permissions', () => {
  it('lets manager, accountant and admin read cost, stock and the rate', async () => {
    for (const role of ['MANAGER', 'ACCOUNTANT', 'ADMIN'] as const) {
      const { costApi, stockApi, asRole } = setup([role]);
      asRole([role]);
      await expect(costApi.getUsdRate()).resolves.toBeDefined();
      await expect(costApi.getPriceListCosts()).resolves.toBeDefined();
      await expect(stockApi.listStock()).resolves.toBeDefined();
    }
  });

  it('denies warehouse, driver and an anonymous caller every read', async () => {
    for (const roles of [['WAREHOUSE_MANAGER'], ['DRIVER'], []] as const) {
      const { costApi, stockApi, idOf } = setup(roles);
      await expect(costApi.getUsdRate()).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(costApi.getPriceListCosts()).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(costApi.getProductCostReference(idOf('10482'))).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(stockApi.listUnpriced()).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(stockApi.listStock()).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(stockApi.listSyncRuns()).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(stockApi.listSupplyRemovals()).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('lets the accountant view but never change the rate or decide a removal', async () => {
    const { costApi, stockApi } = setup(['ACCOUNTANT']);
    await expect(costApi.setUsdRate({ rate: '12700' })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(costApi.followCentralBank()).rejects.toBeInstanceOf(PermissionDeniedError);
    const { items } = await stockApi.listSupplyRemovals();
    const first = items[0];
    if (!first) throw new Error('expected a pending request');
    await expect(stockApi.confirmSupplyRemoval(first.id)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(stockApi.dismissSupplyRemoval(first.id)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe('fake cost backend: responses follow the shared contract', () => {
  it('every read parses with the strict schema the web uses', async () => {
    const { costApi, stockApi, idOf } = setup();
    priceListCostsResponseSchema.parse(await costApi.getPriceListCosts());
    usdRateResponseSchema.parse(await costApi.getUsdRate());
    const reference = await costApi.getProductCostReference(idOf('10491'));
    for (const delivery of reference.deliveries) costDeliverySchema.parse(delivery);
    unpricedProductsResponseSchema.parse(await stockApi.listUnpriced());
    stockOverviewResponseSchema.parse(await stockApi.listStock());
    sheetSyncRunsResponseSchema.parse(await stockApi.listSyncRuns());
    supplyRemovalListResponseSchema.parse(await stockApi.listSupplyRemovals());
  });

  it("computes so'm with fixed-point math (128.5 USD x 12650 = 1 625 525.00)", async () => {
    const { costApi, idOf } = setup();
    const reference = await costApi.getProductCostReference(idOf('10491'));
    expect(reference.latest?.costUzs).toBe('1625525.00');
    expect(reference.deliveries[0]).toEqual(reference.latest);
  });
});

describe('fake cost backend: cost list of the current price list', () => {
  it('covers exactly the published products, newest delivery first, at most 5 recent', async () => {
    const { costApi, price, idOf } = setup();
    const costs = await costApi.getPriceListCosts();
    expect(costs.items.map((i) => i.productId).sort()).toEqual(
      [...price.view.publishedProductIds()].sort(),
    );
    const a15 = costs.items.find((i) => i.productId === idOf('10491'));
    expect(a15?.recent).toHaveLength(5);
    expect(a15?.latest).toEqual(a15?.recent[0]);
    expect(a15?.stockQuantity).toBe('59.000');
    // A priced product without any delivery has no cost and no stock aggregate.
    const noDelivery = costs.items.find((i) => i.productId === idOf('10499'));
    expect(noDelivery).toMatchObject({ latest: null, recent: [], stockQuantity: null });
  });

  it('answers 404 before the first publish is possible (empty scenario)', async () => {
    const price = createFakePriceBackend();
    const cost = createFakeCostBackend({
      view: price.view,
      roles: () => ['MANAGER'],
      scenario: () => 'empty',
    });
    await expect(cost.costApi.getPriceListCosts()).rejects.toBeInstanceOf(ApiNotFoundError);
  });
});

describe('fake cost backend: USD rate', () => {
  it('a manual rate sticks, records the actor and keeps following off', async () => {
    const { costApi } = setup(['MANAGER']);
    const result = await costApi.setUsdRate({ rate: '12700.5' });
    expect(result).toMatchObject({
      rate: '12700.5000',
      source: 'MANUAL',
      followsCentralBank: false,
      rateDate: null,
    });
    expect((await costApi.getUsdRate()).rate).toBe('12700.5000');
  });

  it('rejects a rate that is not a positive decimal string', async () => {
    const { costApi } = setup(['ADMIN']);
    await expect(costApi.setUsdRate({ rate: '-5' })).rejects.toBeInstanceOf(ApiValidationError);
    await expect(costApi.setUsdRate({ rate: '12 650' })).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('following the bank goes back to CBU; with the bank down the manual value stays and the failure is flagged', async () => {
    const { costApi, controls } = setup(['MANAGER']);
    await costApi.setUsdRate({ rate: '12700' });
    controls.setCentralBankDown(true);
    const failed = await costApi.followCentralBank();
    expect(failed).toMatchObject({
      rate: '12700.0000',
      source: 'MANUAL',
      followsCentralBank: true,
    });
    expect(failed.lastRefreshFailedAt).not.toBeNull();
    controls.setCentralBankDown(false);
    const ok = await costApi.followCentralBank();
    expect(ok).toMatchObject({
      source: 'CBU',
      followsCentralBank: true,
      lastRefreshFailedAt: null,
    });
  });
});

describe('fake cost backend: unpriced products', () => {
  it('lists the products that have no price in the published list, every one sold by the piece', async () => {
    const { stockApi, price } = setup();
    const { items, categories, uncategorizedCount } = await stockApi.listUnpriced();
    const priced = price.view.publishedProductIds();
    expect(items.every((i) => !priced.has(i.productId))).toBe(true);
    expect(items.map((i) => i.productCode)).toContain('10521');
    expect(items.find((i) => i.productCode === '10521')?.unit).toBe('PIECE');
    expect(items.find((i) => i.productCode === '10494')?.latestDelivery?.costUsd).toBe('175.0000');
    expect(uncategorizedCount).toBe(1);
    expect(categories.reduce((n, c) => n + c.count, 0) + uncategorizedCount).toBe(items.length);
  });

  it('category and search filters narrow the items but the tab counts ignore the category', async () => {
    const { stockApi } = setup();
    const all = await stockApi.listUnpriced();
    const tablets = await stockApi.listUnpriced({ category: 'Planshetlar' });
    expect(tablets.items.map((i) => i.productCode)).toEqual(['10494', '10521']);
    expect(tablets.categories).toEqual(all.categories);
    const searched = await stockApi.listUnpriced({ search: 'baseus' });
    expect(searched.items.map((i) => i.productCode)).toEqual(['10522']);
    expect(searched.categories).toEqual([{ category: 'Aksessuarlar', count: 1 }]);
  });

  it('publishing a price moves the product to the priced side (no drafts)', async () => {
    const { stockApi, price, idOf } = setup();
    const id = idOf('10494');
    expect(
      (await stockApi.listUnpriced()).items.find((i) => i.productId === id)?.hasDraftPrice,
    ).toBe(false);
    const { version } = await price.pricingApi.getCurrent();
    await price.pricingApi.publishChanges({
      baseVersionNumber: version.number,
      upserts: [{ productId: id, basePrice: '4200000', deferredPrice: null, rrp: null }],
      removedProductIds: [],
    });
    expect((await stockApi.listUnpriced()).items.some((i) => i.productId === id)).toBe(false);
  });

  it('a sheet product without a stored unit is priced at once (pieces only)', async () => {
    const { price, stockApi, idOf } = setup();
    const id = idOf('10521');
    expect((await stockApi.listUnpriced()).items.find((i) => i.productId === id)?.unit).toBe(
      'PIECE',
    );
    await expect(
      price.pricingApi.publishChanges({
        baseVersionNumber: (await price.pricingApi.getCurrent()).version.number,
        upserts: [{ productId: id, basePrice: '1500000', deferredPrice: null, rrp: null }],
        removedProductIds: [],
      }),
    ).resolves.toBeDefined();
  });
});

describe('fake cost backend: stock overview', () => {
  it('lists products with stock or deliveries, with the priced flag and delivery counts', async () => {
    const { stockApi } = setup();
    const { items } = await stockApi.listStock();
    const byCode = new Map(items.map((i) => [i.productCode, i]));
    expect(byCode.has('10499')).toBe(false);
    expect(byCode.has('10525')).toBe(false);
    expect(byCode.get('10491')).toMatchObject({
      isPriced: true,
      deliveryCount: 6,
      stockQuantity: '59.000',
    });
    expect(byCode.get('10521')).toMatchObject({ isPriced: false, deliveryCount: 1 });
  });

  it('inStock filters by quantity above zero or none; category tabs ignore the category filter', async () => {
    const { stockApi } = setup();
    const inStock = await stockApi.listStock({ inStock: true });
    expect(
      inStock.items.every((i) => i.stockQuantity !== null && i.stockQuantity !== '0.000'),
    ).toBe(true);
    const out = await stockApi.listStock({ inStock: false });
    expect(out.items.map((i) => i.productCode)).toEqual(['10487', '10493', '10498', '10524']);
    const phones = await stockApi.listStock({ category: 'Telefonlar' });
    expect(phones.items.every((i) => i.category === 'Telefonlar')).toBe(true);
    expect(phones.categories.length).toBeGreaterThan(1);
  });
});

describe('fake cost backend: sync reports and removals', () => {
  it('returns runs newest first and honours the limit', async () => {
    const { stockApi } = setup();
    const { items } = await stockApi.listSyncRuns(2);
    expect(items).toHaveLength(2);
    expect((items[0]?.startedAt ?? '') > (items[1]?.startedAt ?? '')).toBe(true);
    expect((await stockApi.getLastSyncRun())?.id).toBe(items[0]?.id);
  });

  it('confirming a removal stops counting the line for stock and cost history', async () => {
    const { stockApi, costApi, idOf } = setup(['MANAGER']);
    const before = await stockApi.listSupplyRemovals();
    expect(before.total).toBe(2);
    const request = before.items.find((r) => r.productCode === '10483');
    if (!request) throw new Error('expected the 10483 request');
    const stockBefore = (await stockApi.listStock()).items.find((i) => i.productCode === '10483');
    const decision = await stockApi.confirmSupplyRemoval(request.id);
    expect(decision.status).toBe('CONFIRMED');
    expect((await stockApi.listSupplyRemovals()).total).toBe(1);
    const stockAfter = (await stockApi.listStock()).items.find((i) => i.productCode === '10483');
    expect(stockAfter?.deliveryCount).toBe((stockBefore?.deliveryCount ?? 0) - 1);
    expect(stockAfter?.stockQuantity).toBe('74.000');
    const history = await costApi.getProductCostReference(idOf('10483'));
    expect(history.deliveries.some((d) => d.deliveryRef === request.deliveryRef)).toBe(false);
  });

  it('party numbers: manager only, and refused like the server', async () => {
    const denied = setup(['ADMIN']).stockApi;
    await expect(denied.listSupplies()).rejects.toBeInstanceOf(PermissionDeniedError);

    const { stockApi } = setup(['MANAGER']);
    const { items } = await stockApi.listSupplies();
    const free = items.filter((row) => row.partyNumber === null);
    const taken = items.find((row) => row.partyNumber !== null);
    const [first, second] = free;
    if (!first || !second || !taken) throw new Error('expected free and taken supplies');
    for (const row of items) expect(JSON.stringify(row)).not.toMatch(/cost|supplier/i);

    const seen = (...rows: (typeof first)[]) =>
      rows.map(({ deliveryRef, partyNumber }) => ({ deliveryRef, partyNumber }));
    await stockApi.setSupplyParty({
      deliveryRefs: [first.deliveryRef],
      partyNumber: '7',
      seenParties: seen(first),
    });
    await expect(
      stockApi.setSupplyParty({
        deliveryRefs: [second.deliveryRef],
        partyNumber: '7',
        seenParties: seen(second),
      }),
    ).rejects.toMatchObject({
      reason: 'SUPPLY_PARTY_CONFLICT',
      details: { partyMembers: [first.deliveryRef] },
    });
    await expect(
      stockApi.setSupplyParty({
        deliveryRefs: [first.deliveryRef],
        partyNumber: '8',
        seenParties: seen(first),
      }),
    ).rejects.toMatchObject({ reason: 'SUPPLY_PARTY_CHANGED' });
    await expect(
      stockApi.setSupplyParty({
        deliveryRefs: ['no-such-supply'],
        partyNumber: '8',
        seenParties: [{ deliveryRef: 'no-such-supply', partyNumber: null }],
      }),
    ).rejects.toMatchObject({ reason: 'SUPPLY_NOT_AVAILABLE' });
    const again = await stockApi.setSupplyParty({
      deliveryRefs: [first.deliveryRef],
      partyNumber: '7',
      seenParties: [{ deliveryRef: first.deliveryRef, partyNumber: '7' }],
    });
    expect(again.outcome).toBe('NOTHING_TO_DO');
    const replaced = await stockApi.setSupplyParty({
      deliveryRefs: [second.deliveryRef],
      partyNumber: '7',
      seenParties: seen(second),
      onPartyConflict: 'REPLACE_MEMBERS',
      seenPartyMembers: [first.deliveryRef],
    });
    expect(replaced.removedFromParty).toEqual([first.deliveryRef]);
  });

  it('dismissing keeps the line; deciding twice is a 409 REMOVAL_REQUEST_NOT_PENDING', async () => {
    const { stockApi } = setup(['ADMIN']);
    const [first] = (await stockApi.listSupplyRemovals()).items;
    if (!first) throw new Error('expected a pending request');
    const stockBefore = (await stockApi.listStock()).items.find(
      (i) => i.productId === first.productId,
    );
    await stockApi.dismissSupplyRemoval(first.id);
    const stockAfter = (await stockApi.listStock()).items.find(
      (i) => i.productId === first.productId,
    );
    expect(stockAfter?.deliveryCount).toBe(stockBefore?.deliveryCount);
    await expect(stockApi.confirmSupplyRemoval(first.id)).rejects.toMatchObject({
      reason: 'REMOVAL_REQUEST_NOT_PENDING',
    });
    await expect(
      stockApi.dismissSupplyRemoval('00000000-0000-4000-8000-00000000dead'),
    ).rejects.toBeInstanceOf(ApiNotFoundError);
  });
});

describe('fake cost backend: dev scenarios', () => {
  let scenario: 'error' | 'denied' | 'empty' = 'error';
  beforeEach(() => {
    scenario = 'error';
  });

  it('error, denied and empty scenarios shape the read calls', async () => {
    const price = createFakePriceBackend();
    const { stockApi } = createFakeCostBackend({
      view: price.view,
      roles: () => ['MANAGER'],
      scenario: () => scenario,
    });
    await expect(stockApi.listStock()).rejects.toThrow();
    scenario = 'denied';
    await expect(stockApi.listStock()).rejects.toBeInstanceOf(PermissionDeniedError);
    scenario = 'empty';
    expect((await stockApi.listStock()).items).toEqual([]);
    expect(await stockApi.getLastSyncRun()).toBeNull();
  });
});

describe('fake cost backend: "sync now"', () => {
  it('queues a run for a manager, answers ALREADY_QUEUED while it is pending, then lists the new MANUAL run', async () => {
    vi.useFakeTimers();
    try {
      const { stockApi } = setup(['MANAGER']);
      const before = await stockApi.getLastSyncRun();
      await expect(stockApi.requestSyncRun()).resolves.toEqual({ outcome: 'QUEUED' });
      await expect(stockApi.requestSyncRun()).resolves.toEqual({ outcome: 'ALREADY_QUEUED' });
      await vi.advanceTimersByTimeAsync(FAKE_SYNC_DURATION_MS + 1);
      const after = await stockApi.getLastSyncRun();
      expect(after?.id).not.toBe(before?.id);
      expect(after?.trigger).toBe('MANUAL');
      expect((await stockApi.listSyncRuns()).items[0]?.id).toBe(after?.id);
      await expect(stockApi.requestSyncRun()).resolves.toEqual({ outcome: 'QUEUED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the accountant and everyone below', async () => {
    for (const roles of [['ACCOUNTANT'], ['WAREHOUSE_MANAGER'], ['DRIVER'], []] as const) {
      const { stockApi } = setup(roles);
      await expect(stockApi.requestSyncRun()).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });
});
