import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { SessionState } from '@/features/customer-session/composables/customer-session';
import { startRouteFor, useStartRoute } from './use-start-route';

describe('startRouteFor', () => {
  it('maps "prices" to the price list and nothing else anywhere', () => {
    expect(startRouteFor('prices')).toEqual({ name: 'customer-catalog' });
    expect(startRouteFor(null)).toBeNull();
    expect(startRouteFor('orders')).toBeNull();
    expect(startRouteFor('toString')).toBeNull();
  });
});

describe('startRouteFor: an order', () => {
  const ORDER_ID = '0193e4a2-7c1b-7d3e-9f00-1a2b3c4d5e6f';

  it('maps the order start value of the bot buttons to that order page', () => {
    expect(startRouteFor(`order_${ORDER_ID}`)).toEqual({
      name: 'customer-order',
      params: { id: ORDER_ID },
    });
  });

  it('opens nothing for a value that does not name one order', () => {
    for (const param of ['order_', 'order_123', `order_${ORDER_ID}_placed`, ORDER_ID]) {
      expect(startRouteFor(param), param).toBeNull();
    }
  });

  it('opens the order once the session is ready', async () => {
    const replace = vi.fn(() => Promise.resolve());
    useStartRoute(ref<SessionState>('ready'), { replace }, () => `order_${ORDER_ID}`);
    await nextTick();
    expect(replace).toHaveBeenCalledWith({ name: 'customer-order', params: { id: ORDER_ID } });
  });
});

describe('useStartRoute', () => {
  it('opens the price list once the session is ready, taking the parameter only then', async () => {
    const state = ref<SessionState>('loading');
    const replace = vi.fn(() => Promise.resolve());
    const take = vi.fn(() => 'prices');
    useStartRoute(state, { replace }, take);

    expect(take).not.toHaveBeenCalled();
    state.value = 'denied';
    await nextTick();
    expect(take).not.toHaveBeenCalled();

    state.value = 'ready';
    await nextTick();
    expect(take).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith({ name: 'customer-catalog' });

    // A later sign-in in the same page load does not move the person again.
    state.value = 'loading';
    await nextTick();
    state.value = 'ready';
    await nextTick();
    expect(take).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('works when the session is already ready, and stays put without a known parameter', async () => {
    const replace = vi.fn(() => Promise.resolve());
    useStartRoute(ref<SessionState>('ready'), { replace }, () => 'prices');
    expect(replace).toHaveBeenCalledWith({ name: 'customer-catalog' });

    const other = vi.fn(() => Promise.resolve());
    useStartRoute(ref<SessionState>('ready'), { replace: other }, () => null);
    useStartRoute(ref<SessionState>('ready'), { replace: other }, () => 'unknown');
    await nextTick();
    expect(other).not.toHaveBeenCalled();
  });
});
