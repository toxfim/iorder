import type { CustomerOrderSummary, OrderStatus } from '@iorder/shared';
import { describe, expect, it, vi } from 'vitest';
import type { OrderListQuery } from '../api/customer-orders-api';
import { createOrderPages, type OrderPages } from './order-pages';

// A tiny server: orders newest first, filtered by one status, `size` per page.
function order(number: number, status: OrderStatus): CustomerOrderSummary {
  return {
    id: `order-${String(number).padStart(3, '0')}`,
    orderNumber: `IO-${number}`,
    status,
    // A higher number is a newer order.
    submittedAt: new Date(Date.UTC(2026, 9, 1, 0, number)).toISOString(),
  } as CustomerOrderSummary;
}

function server(orders: readonly CustomerOrderSummary[], size: number) {
  const list = vi.fn((query: OrderListQuery = {}) => {
    const all = orders
      .filter((o) => query.status === undefined || o.status === query.status)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    const start = query.cursor === undefined ? 0 : all.findIndex((o) => o.id === query.cursor) + 1;
    const page = all.slice(start, start + size);
    const last = page[page.length - 1];
    return Promise.resolve({
      orders: page,
      nextCursor: start + size < all.length && last ? last.id : null,
    });
  });
  return { list };
}

const numbers = (orders: readonly CustomerOrderSummary[]): string[] =>
  orders.map((o) => o.orderNumber);

async function drain(pages: OrderPages): Promise<string[][]> {
  const out: string[][] = [];
  while (pages.hasMore()) out.push(numbers(await pages.next()));
  return out;
}

const ORDERS = [
  order(1, 'REJECTED'),
  order(2, 'CANCELLED'),
  order(3, 'REJECTED'),
  order(4, 'DELIVERED'),
  order(5, 'REJECTED'),
  order(6, 'CANCELLED'),
  order(7, 'REJECTED'),
  order(8, 'SUBMITTED'),
  order(9, 'REJECTED'),
];
const REFUSED_NEWEST_FIRST = ['IO-9', 'IO-7', 'IO-6', 'IO-5', 'IO-3', 'IO-2', 'IO-1'];

describe('order pages', () => {
  it('without statuses passes the server pages through, with the cursor of the page before', async () => {
    const api = server(ORDERS, 4);
    const pages = createOrderPages(api, { search: 'IO' }, null);
    expect(await drain(pages)).toEqual([
      ['IO-9', 'IO-8', 'IO-7', 'IO-6'],
      ['IO-5', 'IO-4', 'IO-3', 'IO-2'],
      ['IO-1'],
    ]);
    expect(api.list.mock.calls.map(([query]) => query)).toEqual([
      { search: 'IO' },
      { search: 'IO', cursor: 'order-006' },
      { search: 'IO', cursor: 'order-002' },
    ]);
  });

  it('merges the statuses of a state newest first: every order once, none skipped', async () => {
    const api = server(ORDERS, 2);
    const pages = createOrderPages(api, {}, ['REJECTED', 'CANCELLED']);
    expect((await drain(pages)).flat()).toEqual(REFUSED_NEWEST_FIRST);
    // Each request names one status: that is all the server filters by.
    expect(api.list.mock.calls.every(([query]) => query?.status !== undefined)).toBe(true);
  });

  it('never hands out an order while a newer one may still be unread in another stream', async () => {
    const pages = createOrderPages(server(ORDERS, 2), {}, ['REJECTED', 'CANCELLED']);
    // REJECTED holds 9 and 7, CANCELLED 6 and 2: after 9 and 7 the REJECTED stream is dry and its
    // next order (5) is unknown, so 6 waits although it was read.
    expect(numbers(await pages.next())).toEqual(['IO-9', 'IO-7']);
    expect(pages.hasMore()).toBe(true);
  });

  it('a state with no orders ends at once', async () => {
    const pages = createOrderPages(server(ORDERS, 2), {}, ['RELEASED', 'RECEIVED']);
    expect(await pages.next()).toEqual([]);
    expect(pages.hasMore()).toBe(false);
  });

  it('a failed read loses nothing: the retry reads only what is missing', async () => {
    const api = server(ORDERS, 2);
    const pages = createOrderPages(api, {}, ['REJECTED', 'CANCELLED']);
    api.list.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await expect(pages.next()).rejects.toThrow('offline');
    expect(pages.hasMore()).toBe(true);
    expect((await drain(pages)).flat()).toEqual(REFUSED_NEWEST_FIRST);
    // Two first reads, one of them failed and was repeated; the rest are the later pages.
    const firstReads = api.list.mock.calls.filter(([query]) => query?.cursor === undefined);
    expect(firstReads).toHaveLength(3);
  });
});
