import { shallowRef, type Ref } from 'vue';
import { ApiNotFoundError } from '@core/lib/api-errors';
import type { PricingApi } from '../api/pricing-api';

export interface PublishedVersionInfo {
  readonly number: number;
  /** ISO UTC instant. */
  readonly publishedAt: string;
}

export interface PriceVersionStore {
  /** The published price list version, or null before the first publish / when unknown. */
  readonly version: Readonly<Ref<PublishedVersionInfo | null>>;
  refresh: () => Promise<void>;
  /** Forgets the value (a different person signs in) and discards any read still in flight. */
  reset: () => void;
}

/**
 * "Narx ro'yxati v14 · 08:30" appears in the sidebar and on the home page. The pages that publish
 * call `refresh()` so both stay current.
 */
export function createPriceVersionStore(api: PricingApi): PriceVersionStore {
  const version = shallowRef<PublishedVersionInfo | null>(null);

  let generation = 0;

  function reset(): void {
    generation += 1;
    version.value = null;
  }

  async function refresh(): Promise<void> {
    const mine = generation;
    try {
      const current = await api.getCurrent();
      if (mine !== generation) return;
      const { number, publishedAt } = current.version;
      version.value = publishedAt ? { number, publishedAt } : null;
    } catch (caught) {
      if (mine !== generation) return;
      // No published list yet is a normal state; any other failure leaves the last known value.
      if (caught instanceof ApiNotFoundError) version.value = null;
    }
  }

  return { version, refresh, reset };
}
