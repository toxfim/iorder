import { CUSTOMER_ORDER_GROUP_STATUSES, type OrderStatus } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { waitFor } from '@core/test-utils/wait';
import { mountCustomerApp, useCustomerTestLifecycle } from '@/test-utils/customer-app';
import { customerUz } from './messages/uz';

// The home page prints an order's state in two places: the active order card and the recent
// orders. Both show one of the three customer states (owner rule 2026-11-09).

useCustomerTestLifecycle();
const STATE = customerUz.orderState;

const text = (testId: string): string | undefined =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim();

/** The server answers with this status for the orders of one group of the home page. */
const groupInStatus =
  (group: 'ACTIVE' | 'COMPLETED', status: OrderStatus) =>
  (backend: Awaited<ReturnType<typeof mountCustomerApp>>['backend']): void => {
    const original = backend.ordersApi.list;
    backend.ordersApi.list = async (query) => {
      const page = await original(query);
      return query?.group === group
        ? { ...page, orders: page.orders.map((o) => ({ ...o, status })) }
        : page;
    };
  };

describe('home: the active order card', () => {
  it.each([
    ['SUBMITTED', STATE.ACCEPTED, STATE.hint.ACCEPTED],
    ['MANAGER_APPROVED', STATE.ACCEPTED, STATE.hint.ACCEPTED],
    ['ACCOUNTING_CLEARED', STATE.ACCEPTED, STATE.hint.ACCEPTED],
    ['RELEASED', STATE.ACCEPTED, STATE.hint.ACCEPTED],
    ['DELIVERED', STATE.DELIVERED, STATE.hint.AWAITING_RECEIPT],
  ] as const)('%s: the state in words and what comes next', async (status, label, hint) => {
    await mountCustomerApp('fake-owner', '/', { decorate: groupInStatus('ACTIVE', status) });
    await waitFor(() => expect(document.querySelector('.active-order')).not.toBeNull());
    expect(text('home-order-state')).toBe(label);
    expect(text('home-order-hint')).toBe(hint);
    // No six-segment bar and no icon for one internal step (the truck icon is decoration).
    expect(document.querySelector('.active-order [role="img"]')).toBeNull();
    expect(document.querySelector('.active-order img')).toBeNull();
  });

  it('covers every status the server calls active', () => {
    expect([...CUSTOMER_ORDER_GROUP_STATUSES.ACTIVE].sort()).toEqual(
      ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED'].sort(),
    );
  });
});

describe('home: recent orders', () => {
  it.each([
    ['RECEIVED', STATE.DELIVERED],
    ['REJECTED', STATE.REFUSED],
    ['CANCELLED', STATE.REFUSED],
  ] as const)('%s reads as its state', async (status, label) => {
    await mountCustomerApp('fake-owner', '/', { decorate: groupInStatus('COMPLETED', status) });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="recent-order-state"]')).toHaveLength(2),
    );
    const shown = [...document.querySelectorAll('[data-testid="recent-order-state"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(shown).toEqual([label, label]);
  });

  it('the seeded home shows the three states side by side', async () => {
    await mountCustomerApp('fake-owner', '/');
    await waitFor(() => expect(document.querySelector('.active-order')).not.toBeNull());
    expect(text('home-order-state')).toBe(STATE.ACCEPTED);
    const recent = [...document.querySelectorAll('[data-testid="recent-order-state"]')].map((el) =>
      el.textContent?.trim(),
    );
    // The two newest finished orders: a received one and a rejected one.
    expect(recent).toEqual([STATE.DELIVERED, STATE.REFUSED]);
  });
});
