import { ref, shallowRef, type Ref } from 'vue';
import type { TimelineResponse } from '../domain/timeline-model';
import { useServices } from '@/app/services';
import type { ViewState } from '@core/composables/use-async-view';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import type { OrderDetail } from '../domain/order-model';

export type DetailState = ViewState | 'notFound';
export type TimelineState = 'loading' | 'ready' | 'error';

/**
 * One order with its timeline, read through the staff orders api. The timeline is a separate
 * request: if it fails the order is still usable and the timeline shows its own error with a
 * retry. A newer load wins over older ones. `silent` keeps the current content on screen while
 * the data is re-read (after an action or a stale row version).
 */
export function useOrderDetail(orderId: () => string, options: { timeline: boolean }) {
  const { ordersApi } = useServices();
  const order = shallowRef<OrderDetail | null>(null);
  const timeline = shallowRef<TimelineResponse | null>(null);
  const state: Ref<DetailState> = ref('loading');
  const timelineState: Ref<TimelineState> = ref('loading');
  let run = 0;

  async function loadTimeline(id: string, mine: number): Promise<void> {
    try {
      const result = await ordersApi.getTimeline(id);
      if (mine !== run) return;
      timeline.value = result;
      timelineState.value = 'ready';
    } catch {
      if (mine !== run) return;
      timelineState.value = 'error';
    }
  }

  async function load({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const mine = ++run;
    const id = orderId();
    if (!silent) {
      state.value = 'loading';
      timelineState.value = 'loading';
    }
    const pendingTimeline = options.timeline ? loadTimeline(id, mine) : Promise.resolve();
    try {
      const result = await ordersApi.getOrder(id);
      if (mine !== run) return;
      order.value = result;
      state.value = 'ready';
    } catch (caught) {
      if (mine !== run) return;
      order.value = null;
      if (caught instanceof ApiNotFoundError) state.value = 'notFound';
      else state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
    await pendingTimeline;
  }

  return { order, timeline, state, timelineState, load };
}
