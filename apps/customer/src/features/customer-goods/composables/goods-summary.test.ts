import { describe, expect, it, vi } from 'vitest';
import type { CustomerGoodsSummary } from '@iorder/shared';
import type { CustomerGoodsApi } from '../api/customer-goods-api';
import { createGoodsSummary } from './goods-summary';
const summary: CustomerGoodsSummary = {
  hasProducts: true,
  productCount: 1,
  unitCount: 4,
  discoveryPending: true,
};
describe('goods summary identity boundaries', () => {
  it('does not restore the previous identity when a late request completes after logout', async () => {
    let resolve: (value: CustomerGoodsSummary) => void = () => undefined;
    const api = {
      summary: () =>
        new Promise<CustomerGoodsSummary>((done) => {
          resolve = done;
        }),
    } as CustomerGoodsApi;
    const store = createGoodsSummary(api);
    const pending = store.refresh();
    store.clear();
    resolve(summary);
    await pending;
    expect(store.summary.value).toBeNull();
    expect(store.loading.value).toBe(false);
  });
  it('acknowledges only after a successful server write and keeps a failed acknowledgement retryable', async () => {
    const ack = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const store = createGoodsSummary({
      summary: async () => summary,
      acknowledgeDiscovery: ack,
    } as unknown as CustomerGoodsApi);
    await store.refresh();
    await expect(store.acknowledge()).rejects.toThrow('offline');
    expect(store.summary.value?.discoveryPending).toBe(true);
    await store.acknowledge();
    expect(store.summary.value?.discoveryPending).toBe(false);
  });
});
