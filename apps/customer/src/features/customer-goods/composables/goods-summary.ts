import { readonly, ref, shallowRef } from 'vue';
import type { CustomerGoodsSummary } from '@iorder/shared';
import type { CustomerGoodsApi } from '../api/customer-goods-api';
export function createGoodsSummary(api: CustomerGoodsApi) {
  const summary = shallowRef<CustomerGoodsSummary | null>(null);
  const error = shallowRef<unknown>(null);
  const loading = ref(false);
  let revision = 0;
  async function refresh(): Promise<void> {
    const mine = ++revision;
    loading.value = true;
    error.value = null;
    try {
      const answer = await api.summary();
      if (mine === revision) summary.value = answer;
    } catch (caught) {
      if (mine === revision) {
        error.value = caught;
        summary.value = null;
      }
    } finally {
      if (mine === revision) loading.value = false;
    }
  }
  function clear(): void {
    revision += 1;
    summary.value = null;
    error.value = null;
    loading.value = false;
  }
  async function acknowledge(): Promise<void> {
    await api.acknowledgeDiscovery();
    if (summary.value) summary.value = { ...summary.value, discoveryPending: false };
  }
  return {
    summary: readonly(summary),
    error: readonly(error),
    loading: readonly(loading),
    refresh,
    clear,
    acknowledge,
  };
}
export type GoodsSummaryStore = ReturnType<typeof createGoodsSummary>;
