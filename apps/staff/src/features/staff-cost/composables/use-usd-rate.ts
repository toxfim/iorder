import { shallowRef } from 'vue';
import type { UsdRateResponse } from '@iorder/shared/staff-cost';
import type { ViewState } from '@core/composables/use-async-view';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { CostApi } from '../api/cost-api';
import { parseRateInput } from '../domain/rate-input';

export type RateSaveResult =
  | { readonly ok: true; readonly rate: UsdRateResponse }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'invalid' | 'ambiguous' | 'failed';
      readonly error?: unknown;
    };

/** The price-list USD rate: current value, saving a manual one, following the Central Bank. */
export function useUsdRate(api: CostApi) {
  const state = shallowRef<ViewState>('loading');
  const rate = shallowRef<UsdRateResponse | null>(null);
  const error = shallowRef<unknown>(null);
  const busy = shallowRef(false);
  let run = 0;

  async function load(): Promise<void> {
    const mine = ++run;
    state.value = 'loading';
    error.value = null;
    try {
      const loaded = await api.getUsdRate();
      if (mine !== run) return;
      rate.value = loaded;
      state.value = 'ready';
    } catch (caught) {
      if (mine !== run) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  async function mutate(call: () => Promise<UsdRateResponse>): Promise<RateSaveResult> {
    busy.value = true;
    try {
      const next = await call();
      run += 1; // a slower initial load must not overwrite this answer
      rate.value = next;
      state.value = 'ready';
      return { ok: true, rate: next };
    } catch (caught) {
      return { ok: false, reason: 'failed', error: caught };
    } finally {
      busy.value = false;
    }
  }

  /** Validates with the api's own rule first; nothing is sent for an invalid value. */
  async function save(raw: string): Promise<RateSaveResult> {
    if (busy.value) return { ok: false, reason: 'failed' };
    const parsed = parseRateInput(raw);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return mutate(() => api.setUsdRate({ rate: parsed.value }));
  }

  async function follow(): Promise<RateSaveResult> {
    if (busy.value) return { ok: false, reason: 'failed' };
    return mutate(() => api.followCentralBank());
  }

  void load();
  return { state, rate, error, busy, load, save, follow };
}

export type UsdRateModel = ReturnType<typeof useUsdRate>;
