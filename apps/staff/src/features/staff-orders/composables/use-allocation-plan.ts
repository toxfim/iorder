import { computed, ref, shallowRef } from 'vue';
import type { AllocationPreview } from '@iorder/shared/staff-orders';
import { useServices } from '@/app/services';
import { ApiConflictError, PermissionDeniedError } from '@core/lib/api-errors';
import {
  currentDraft,
  draftIsValid,
  draftRows,
  fifoDraft,
  modeOf,
  previewOfConflict,
  type PlanChoice,
  type PlanDraft,
} from '../domain/allocation-plan';

export type PlanState = 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'closed';

/** Why the plan on screen is not the one the manager last saw. */
export type PlanNotice = 'CHANGED' | 'INSUFFICIENT' | null;

/**
 * The manager's plan of one order: the server's preview, the draft on top of it, and what a 409 says.
 * Shared by the approval dialog, the order page's approval and the later change of holds.
 */
export function useAllocationPlan() {
  const { ordersApi } = useServices();
  const state = ref<PlanState>('idle');
  const preview = shallowRef<AllocationPreview | null>(null);
  const draft = shallowRef<PlanDraft>({});
  const notice = ref<PlanNotice>(null);
  let run = 0;

  function adopt(next: AllocationPreview, start: 'FIFO' | 'CURRENT' = 'FIFO'): void {
    preview.value = next;
    draft.value = start === 'CURRENT' ? currentDraft(next) : fifoDraft(next);
    state.value = 'ready';
  }

  async function load(orderId: string, start: 'FIFO' | 'CURRENT' = 'FIFO'): Promise<void> {
    const mine = ++run;
    state.value = 'loading';
    preview.value = null;
    notice.value = null;
    try {
      const next = await ordersApi.getAllocationPreview(orderId);
      if (mine === run) adopt(next, start);
    } catch (caught) {
      if (mine !== run) return;
      if (caught instanceof ApiConflictError && caught.reason === 'ALLOCATION_NOT_CHANGEABLE') {
        state.value = 'closed';
      } else {
        state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
      }
    }
  }

  /** Takes the fresh plan out of a refusal. False when the error is about something else. */
  function absorbConflict(caught: unknown): boolean {
    if (!(caught instanceof ApiConflictError)) return false;
    if (caught.reason !== 'ALLOCATION_CHANGED' && caught.reason !== 'STOCK_INSUFFICIENT') {
      return false;
    }
    const next = previewOfConflict(caught.details);
    if (next === null) return false;
    adopt(next);
    notice.value = caught.reason === 'ALLOCATION_CHANGED' ? 'CHANGED' : 'INSUFFICIENT';
    return true;
  }

  function setQuantity(orderItemId: string, supplyLineId: string, quantity: string): void {
    notice.value = notice.value === 'CHANGED' ? null : notice.value;
    draft.value = {
      ...draft.value,
      [orderItemId]: { ...draft.value[orderItemId], [supplyLineId]: quantity },
    };
  }

  function useFifo(): void {
    if (preview.value !== null) draft.value = fifoDraft(preview.value);
  }

  const canSubmit = computed(
    () =>
      preview.value !== null && preview.value.feasible && draftIsValid(preview.value, draft.value),
  );

  const choice = computed<PlanChoice | null>(() =>
    preview.value === null || !canSubmit.value
      ? null
      : {
          allocationMode: modeOf(preview.value, draft.value),
          allocations: draftRows(preview.value, draft.value),
        },
  );

  return {
    state,
    preview,
    draft,
    notice,
    load,
    adopt,
    absorbConflict,
    setQuantity,
    useFifo,
    canSubmit,
    choice,
  };
}

export type AllocationPlan = ReturnType<typeof useAllocationPlan>;
