import { STAFF_ORDER_ROUTES } from '@iorder/shared/staff-orders';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiConflictError,
  ApiValidationError,
  InvalidResponseError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeOrderId } from '@core/lib/fake-ids';
import { createHttpClient } from '@core/lib/http-client';
import { createFakeStaffOrders } from './fake-staff-orders-backend';
import { createHttpDriversApi } from './drivers-api';
import { createHttpStaffOrdersApi } from './staff-orders-api';

// CONTRACT test of the HTTP adapter: every method hits the route of STAFF_ORDER_ROUTES with the
// body the shared schema wants, and every response is parsed with the shared strict schemas. The
// payloads come from the fake backend, which a separate test checks against the same schemas.

const NOW = { now: () => new Date('2026-10-19T04:30:00.000Z') };
const asManager = () => ({ name: 'Aziza Yusupova', roles: ['MANAGER' as const] });
const ID = fakeOrderId('IO-10491');

async function payloads() {
  const fake = createFakeStaffOrders({ clock: NOW, actor: asManager });
  return {
    list: await fake.ordersApi.listOrders({ limit: 3 }),
    counts: await fake.ordersApi.countOrders(),
    order: await fake.ordersApi.getOrder(ID),
    timeline: await fake.ordersApi.getTimeline(ID),
  };
}

function setup(status: number, body?: unknown) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, api: createHttpStaffOrdersApi(http), http };
}

function call(fetchImpl: ReturnType<typeof setup>['fetchImpl']): [string, RequestInit] {
  return fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
}

describe('createHttpStaffOrdersApi', () => {
  it('lists with the query string and parses the page', async () => {
    const { list } = await payloads();
    const { api, fetchImpl } = setup(200, list);
    const result = await api.listOrders({ limit: 3, status: 'SUBMITTED', search: 'io-104' });
    expect(result.orders).toHaveLength(3);
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('GET');
    expect(url).toBe('https://api.test/staff/orders?status=SUBMITTED&search=io-104&limit=3');
  });

  it('lists by several statuses and the business day; counts over the same filters', async () => {
    const { list, counts } = await payloads();
    const paged = setup(200, list);
    await paged.api.listOrders({ statuses: ['REJECTED', 'CANCELLED'], period: 'TODAY' });
    expect(call(paged.fetchImpl)[0]).toBe(
      'https://api.test/staff/orders?statuses=REJECTED%2CCANCELLED&period=TODAY',
    );
    const counted = setup(200, counts);
    const result = await counted.api.countOrders({
      paymentStatus: 'UNPAID',
      paymentPlan: 'DEFERRED',
      search: 'alpha',
    });
    expect(result.byStatus).toEqual(counts.byStatus);
    expect(call(counted.fetchImpl)[0]).toBe(
      'https://api.test/staff/orders/counts?paymentStatus=UNPAID&paymentPlan=DEFERRED&search=alpha',
    );
  });

  it('reads one order and its timeline', async () => {
    const { order, timeline } = await payloads();
    const read = setup(200, order);
    expect((await read.api.getOrder(ID)).orderNumber).toBe('IO-10491');
    expect(call(read.fetchImpl)[0]).toBe(`https://api.test/staff/orders/${ID}`);
    const history = setup(200, timeline);
    expect((await history.api.getTimeline(ID)).events.length).toBeGreaterThan(0);
    expect(call(history.fetchImpl)[0]).toBe(`https://api.test/staff/orders/${ID}/timeline`);
  });

  it('reads a timeline with an event or notification type it does not know', async () => {
    const { timeline } = await payloads();
    const [first] = timeline.events;
    if (!first) throw new Error('fixture has no event');
    const notification = timeline.events.flatMap((e) => e.notifications)[0];
    if (!notification) throw new Error('fixture has no notification');
    const body = {
      ...timeline,
      events: [
        { ...first, id: fakeOrderId('x1'), type: 'SOMETHING_NEW' },
        {
          ...first,
          id: fakeOrderId('x2'),
          notifications: [{ ...notification, type: 'ORDER_SOMETHING_NEW' }],
        },
        ...timeline.events,
      ],
    };
    const { api } = setup(200, body);
    const read = await api.getTimeline(ID);
    expect(read.events).toHaveLength(body.events.length);
    expect(read.events[0]?.type).toBe('UNKNOWN');
    expect(read.events[1]?.notifications[0]?.type).toBe('UNKNOWN');
    expect(read.events[2]?.type).toBe(timeline.events[0]?.type);
  });

  it('still rejects a timeline that breaks the contract in any other way', async () => {
    const { timeline } = await payloads();
    const [first] = timeline.events;
    if (!first) throw new Error('fixture has no event');
    const extra = setup(200, { ...timeline, events: [{ ...first, phone: '+998' }] });
    await expect(extra.api.getTimeline(ID)).rejects.toBeInstanceOf(InvalidResponseError);
    const badStatus = setup(200, { ...timeline, events: [{ ...first, toStatus: 'NEW_STATUS' }] });
    await expect(badStatus.api.getTimeline(ID)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it.each([
    ['approve', 'POST', 'approve', { skipAccounting: true, expectedRowVersion: 3 }],
    ['reject', 'POST', 'reject', { reason: 'Narx eskirgan', expectedRowVersion: 3 }],
    ['cancel', 'POST', 'cancel', { reason: 'Mijoz bekor qildi', expectedRowVersion: 3 }],
    ['accountingApprove', 'POST', 'accounting-approve', { expectedRowVersion: 3 }],
    ['accountingReject', 'POST', 'accounting-reject', { reason: 'Limit', expectedRowVersion: 3 }],
    ['release', 'POST', 'release', { driverUserId: fakeOrderId('driver'), expectedRowVersion: 3 }],
    ['deliver', 'POST', 'deliver', { comment: 'Eshik oldida', expectedRowVersion: 3 }],
    [
      'editItems',
      'PATCH',
      'items',
      { changes: [{ itemId: fakeOrderId('item'), quantity: null }], expectedRowVersion: 3 },
    ],
  ] as const)(
    '%s sends %s /staff/orders/:id/%s with exactly the request body',
    async (method, verb, path, body) => {
      const { order } = await payloads();
      const { api, fetchImpl } = setup(200, order);
      await (api[method] as (id: string, request: unknown) => Promise<unknown>)(ID, body);
      const [url, init] = call(fetchImpl);
      expect(init.method).toBe(verb);
      expect(url).toBe(`https://api.test/staff/orders/${ID}/${path}`);
      expect(JSON.parse(String(init.body))).toEqual(body);
    },
  );

  it('is built from the shared route table', () => {
    expect(STAFF_ORDER_ROUTES.approveOrder).toEqual({
      method: 'POST',
      path: '/staff/orders/:id/approve',
    });
  });

  it('refuses a response that is not the contract (a leaked field, a missing view marker)', async () => {
    const { order } = await payloads();
    const leak = setup(200, { ...order, costUsd: '1.00' });
    await expect(leak.api.getOrder(ID)).rejects.toBeInstanceOf(InvalidResponseError);
    const withoutMarker = Object.fromEntries(
      Object.entries(order).filter(([key]) => key !== 'detail'),
    );
    const bare = setup(200, withoutMarker);
    await expect(bare.api.getOrder(ID)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('turns a 409 into a typed conflict with the machine-readable reason', async () => {
    const { api } = setup(409, {
      error: { code: 'CONFLICT', message: 'x', reason: 'ORDER_CHANGED', details: {} },
    });
    const error = await api
      .approve(ID, {
        paymentMethod: 'CASH',
        allocationMode: 'FIFO',
        allocations: [],
        expectedRowVersion: 1,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiConflictError);
    expect((error as ApiConflictError).reason).toBe('ORDER_CHANGED');
  });

  it('turns a 422 into a validation error that names the field', async () => {
    const { api } = setup(422, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'x',
        details: [{ path: 'reason', message: 'A reason is required' }],
      },
    });
    const error = await api
      .reject(ID, { reason: ' ', expectedRowVersion: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiValidationError);
    expect((error as ApiValidationError).issues[0]?.path).toBe('reason');
  });
});

describe('createHttpStaffOrdersApi: picking (STAFF_PICKING_ROUTES)', () => {
  const DEMO = fakeOrderId('IO-10500');
  async function pickingPayload() {
    const fake = createFakeStaffOrders({
      clock: NOW,
      actor: () => ({ name: 'Rustam Qodirov', roles: ['WAREHOUSE_MANAGER' as const] }),
      productRule: (code) =>
        code === '10491'
          ? { trackingType: 'IMEI', markingRequired: true }
          : { trackingType: 'NONE', markingRequired: false },
      pickingDemo: true,
    });
    return fake.ordersApi.getPicking(DEMO);
  }

  it('reads the picking view and parses it with the strict shared schema', async () => {
    const view = await pickingPayload();
    const { api, fetchImpl } = setup(200, view);
    const result = await api.getPicking(DEMO);
    expect(result.lines.some((l) => l.trackingType === 'IMEI')).toBe(true);
    expect(call(fetchImpl)[0]).toBe(`https://api.test/staff/orders/${DEMO}/picking`);
    const broken = setup(200, { ...view, editable: 'yes' });
    await expect(broken.api.getPicking(DEMO)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('puts one scan and deletes one code by kind and slot', async () => {
    const view = await pickingPayload();
    const unitId = view.lines[0]?.units[0]?.unitId ?? '';
    const put = setup(200, view);
    await put.api.recordUnitCode(DEMO, unitId, { kind: 'IMEI', slot: 2, value: '490154203237518' });
    const [url, init] = call(put.fetchImpl);
    expect(url).toBe(`https://api.test/staff/orders/${DEMO}/units/${unitId}/codes`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'IMEI',
      slot: 2,
      value: '490154203237518',
    });
    const del = setup(200, view);
    await del.api.clearUnitCode(DEMO, unitId, 'MARKING', 1);
    expect(call(del.fetchImpl)[0]).toBe(
      `https://api.test/staff/orders/${DEMO}/units/${unitId}/codes/MARKING/1`,
    );
    expect(call(del.fetchImpl)[1].method).toBe('DELETE');
  });

  it('keeps the conflict reason and the validator code of a refused scan', async () => {
    const dup = setup(409, {
      error: {
        code: 'CONFLICT',
        message: 'x',
        reason: 'UNIT_CODE_DUPLICATE',
        details: { kind: 'IMEI', orderNumber: 'IO-10001' },
      },
    });
    const conflict = await dup.api
      .recordUnitCode(DEMO, DEMO, { kind: 'IMEI', slot: 1, value: '1' })
      .catch((e: unknown) => e);
    expect((conflict as ApiConflictError).reason).toBe('UNIT_CODE_DUPLICATE');
    const bad = setup(422, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'x',
        details: [{ path: 'value', message: 'IMEI_CHECKSUM' }],
      },
    });
    const invalid = await bad.api
      .recordUnitCode(DEMO, DEMO, { kind: 'IMEI', slot: 1, value: '1' })
      .catch((e: unknown) => e);
    expect((invalid as ApiValidationError).issues[0]?.message).toBe('IMEI_CHECKSUM');
  });
});

describe('createHttpDriversApi', () => {
  it('asks the narrow driver list and keeps id and name only', async () => {
    const user = { id: fakeOrderId('driver'), fullName: 'Bekzod Tursunov' };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [user] }), { status: 200 })),
    );
    const api = createHttpDriversApi(createHttpClient({ baseUrl: 'https://api.test', fetchImpl }));
    expect(await api.listActiveDrivers()).toEqual([{ id: user.id, fullName: 'Bekzod Tursunov' }]);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.test/staff/drivers');
  });

  it('turns a 403 into PermissionDeniedError', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 }),
      ),
    );
    const api = createHttpDriversApi(createHttpClient({ baseUrl: 'https://api.test', fetchImpl }));
    await expect(api.listActiveDrivers()).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
