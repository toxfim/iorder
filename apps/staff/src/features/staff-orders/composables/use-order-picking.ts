import type { PickingResponse } from '@iorder/shared/staff-orders';
import { computed, ref, shallowRef, type Ref } from 'vue';
import { useServices } from '@/app/services';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import {
  describeScanError,
  pickingProgress,
  precheckScan,
  slotKey,
  type ScanRefusal,
  type SlotRef,
} from '../domain/picking-model';

export type PickingState = 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'notFound';

/** The slot a scan went into, with what the person needs to recognise it in the list. */
export interface ScanTarget extends SlotRef {
  readonly unitNo: number;
  readonly productName: string;
}

/** One refused scan, kept on screen: staff scan fast and miss toasts. Newest first. */
export interface RejectedScan {
  readonly id: number;
  readonly target: ScanTarget;
  readonly value: string;
  readonly refusal: ScanRefusal;
  readonly at: Date;
}

/** The outcome of the latest scan or clear, for the slot flash and the live region. */
export interface ScanFeedback {
  readonly seq: number;
  readonly slot: string;
  readonly ok: boolean;
  readonly action: 'scan' | 'clear';
  readonly target: ScanTarget;
  readonly refusal: ScanRefusal | null;
}

/** How many refused scans stay listed (the oldest drop off). */
export const REJECTED_SCANS_MAX = 20;
const SUCCESS_VIBRATION = 40;
const ERROR_VIBRATION = [120, 60, 120];

// Haptic feedback is a bonus: many browsers and webviews have no vibration (or refuse it outside a
// user gesture), and the visual flash and the on-screen list carry the same information.
function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // no vibration on this device: the flash and the list still show the result
  }
}

/**
 * The picking view of one order with the scan and clear calls. Calls are sent one at a time in
 * the order they were made, so a slower answer can never overwrite a newer view, and every answer
 * (the whole picking view) replaces what is on screen. A scan the shared validator refuses never
 * leaves the device.
 */
export function useOrderPicking(orderId: () => string) {
  const { ordersApi, clock } = useServices();
  const picking = shallowRef<PickingResponse | null>(null);
  const state: Ref<PickingState> = ref('idle');
  const rejected = ref<RejectedScan[]>([]);
  const pending = ref<ReadonlySet<string>>(new Set());
  const feedback = shallowRef<ScanFeedback | null>(null);
  let run = 0;
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();

  async function load({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const mine = ++run;
    const id = orderId();
    if (!silent || picking.value === null) state.value = 'loading';
    try {
      const result = await ordersApi.getPicking(id);
      if (mine !== run) return;
      picking.value = result;
      state.value = 'ready';
    } catch (caught) {
      if (mine !== run) return;
      if (silent && picking.value !== null) return;
      picking.value = null;
      if (caught instanceof ApiNotFoundError) state.value = 'notFound';
      else state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  function setPending(key: string, busy: boolean): void {
    const next = new Set(pending.value);
    if (busy) next.add(key);
    else next.delete(key);
    pending.value = next;
  }

  function report(action: 'scan' | 'clear', target: ScanTarget, refusal: ScanRefusal | null): void {
    feedback.value = {
      seq: ++seq,
      slot: slotKey(target),
      ok: refusal === null,
      action,
      target,
      refusal,
    };
    vibrate(refusal === null ? SUCCESS_VIBRATION : ERROR_VIBRATION);
  }

  function refuse(target: ScanTarget, value: string, refusal: ScanRefusal): void {
    rejected.value = [
      { id: seq + 1, target, value, refusal, at: clock.now() },
      ...rejected.value,
    ].slice(0, REJECTED_SCANS_MAX);
    report('scan', target, refusal);
  }

  /** One scan; resolves true once the server stored it. Empty input is ignored. */
  function scan(target: ScanTarget, raw: string): Promise<boolean> {
    const current = picking.value;
    if (current === null || raw.trim() === '') return Promise.resolve(false);
    const checked = precheckScan(current, target, raw);
    if (!checked.ok) {
      refuse(target, raw.trim(), checked.refusal);
      return Promise.resolve(false);
    }
    const key = slotKey(target);
    setPending(key, true);
    return enqueue(async () => {
      try {
        picking.value = await ordersApi.recordUnitCode(orderId(), target.unitId, {
          kind: target.kind,
          slot: target.slot,
          value: checked.value,
        });
        report('scan', target, null);
        return true;
      } catch (caught) {
        const refusal = describeScanError(caught);
        refuse(target, checked.value, refusal);
        if (refusal.reload) void load({ silent: true });
        return false;
      } finally {
        setPending(key, false);
      }
    });
  }

  /** Removes a scanned code so the slot can be scanned again. */
  function clear(target: ScanTarget): Promise<boolean> {
    const key = slotKey(target);
    setPending(key, true);
    return enqueue(async () => {
      try {
        picking.value = await ordersApi.clearUnitCode(
          orderId(),
          target.unitId,
          target.kind,
          target.slot,
        );
        report('clear', target, null);
        return true;
      } catch (caught) {
        const refusal = describeScanError(caught);
        report('clear', target, refusal);
        if (refusal.reload) void load({ silent: true });
        return false;
      } finally {
        setPending(key, false);
      }
    });
  }

  function dismissRejected(): void {
    rejected.value = [];
  }

  const complete = computed(() => picking.value?.complete === true);
  const progress = computed(() =>
    picking.value ? pickingProgress(picking.value) : { done: 0, total: 0 },
  );

  return {
    picking,
    state,
    rejected,
    pending,
    feedback,
    complete,
    progress,
    load,
    scan,
    clear,
    dismissRejected,
  };
}

export type OrderPicking = ReturnType<typeof useOrderPicking>;
