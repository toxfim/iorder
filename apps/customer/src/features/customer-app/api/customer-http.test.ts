import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetInitData, captureLaunchParams } from '@core/telegram/launch';
import {
  ApiConflictError,
  ApiNotFoundError,
  InvalidResponseError,
  NetworkError,
  UnauthenticatedError,
} from '@core/lib/api-errors';
import { readCustomerToken, setCustomerToken } from '@/features/customer-session/website-session';
import { createCustomerHttpClient, createHttpCustomerApis } from '../http';

// The real HTTP clients over a mocked fetch. The payloads have the shapes the api integration
// tests (apps/api/test/orders-http-customer.int-spec.ts) assert; every response is parsed with the
// strict shared schemas, so a field the contract does not know is an InvalidResponseError.

const ID = {
  user: '11111111-1111-4111-8111-111111111111',
  org: '22222222-2222-4222-8222-222222222222',
  product: '33333333-3333-4333-8333-333333333333',
  order: '44444444-4444-4444-8444-444444444444',
  item: '55555555-5555-4555-8555-555555555555',
  event: '66666666-6666-4666-8666-666666666666',
};
const TOKEN = 't'.repeat(43);
const INIT_DATA = 'query_id=AAH&user=%7B%22id%22%3A42%7D&hash=abc';

const ME = {
  userId: ID.user,
  fullName: 'Anvar Soliyev',
  locale: 'UZ',
  staffRoles: [],
  membership: { organizationId: ID.org, role: 'SHOP_OWNER' },
  contact: { fullName: 'Anvar Soliyev', phone: '+998901112233' },
  needsContact: false,
};

const CART = {
  priceListVersionNumber: 15,
  lines: [
    {
      productId: ID.product,
      productCode: 'BASEUS-20W',
      name: 'Baseus 20W zaryadlovchi',
      unit: 'dona',
      quantity: '2.5',
      unitPrice: '89000.00',
      lineTotal: '222500.00',
      deferredUnitPrice: null,
      deferredLineTotal: null,
      rrp: '109000.00',
      orderableStock: 45,
      problem: null,
    },
    {
      productId: '77777777-7777-4777-8777-777777777777',
      productCode: 'OLD',
      name: 'Eski',
      unit: 'dona',
      quantity: '1',
      unitPrice: null,
      lineTotal: null,
      deferredUnitPrice: null,
      deferredLineTotal: null,
      rrp: null,
      orderableStock: null,
      problem: 'INACTIVE',
    },
  ],
  totalAmount: '222500.00',
  deferredTotalAmount: null,
  currency: 'UZS',
  canSubmit: false,
};

const ORDER_SUMMARY = {
  id: ID.order,
  orderNumber: 'IO-10001',
  status: 'SUBMITTED',
  paymentStatus: 'UNPAID',
  paymentPlan: 'FULL',
  totalAmount: '222500.00',
  currency: 'UZS',
  itemCount: 1,
  customerComment: null,
  placedByName: 'Anvar Soliyev',
  placedByMe: true,
  submittedAt: '2026-10-19T08:30:00.000Z',
  updatedAt: '2026-10-19T08:30:00.000Z',
  rowVersion: 1,
};
const ORDER = {
  ...ORDER_SUMMARY,
  items: [
    {
      id: ID.item,
      productId: ID.product,
      productCode: 'BASEUS-20W',
      name: 'Baseus 20W zaryadlovchi',
      unit: 'dona',
      quantity: '2.5',
      unitPrice: '89000.00',
      lineTotal: '222500.00',
    },
  ],
  paymentPlanChangeableUntil: null,
  paymentPlanTotals: null,
};

const TIMELINE = {
  orderId: ID.order,
  events: [
    {
      id: ID.event,
      type: 'SUBMITTED',
      occurredAt: '2026-10-19T08:30:00.000Z',
      fromStatus: null,
      toStatus: 'SUBMITTED',
      actor: { role: 'SHOP_OWNER', name: 'Anvar Soliyev' },
      comment: null,
      itemsChange: null,
      paymentChange: null,
      paymentPlanChange: null,
      customerNotified: true,
    },
    {
      id: '88888888-8888-4888-8888-888888888888',
      type: 'ITEMS_EDITED',
      occurredAt: '2026-10-19T09:00:00.000Z',
      fromStatus: null,
      toStatus: null,
      actor: { role: 'MANAGER', name: null },
      comment: 'Qoldiq sababli',
      itemsChange: {
        oldTotal: '267000.00',
        newTotal: '222500.00',
        lines: [
          {
            productCode: 'BASEUS-20W',
            name: 'Baseus 20W zaryadlovchi',
            change: 'QUANTITY_CHANGED',
            oldQuantity: '3',
            newQuantity: '2.5',
            oldLineTotal: '267000.00',
            newLineTotal: '222500.00',
          },
        ],
      },
      paymentChange: null,
      paymentPlanChange: null,
      customerNotified: true,
    },
  ],
};

const PRICE_LIST = {
  version: { number: 15, publishedAt: '2026-10-19T03:30:00.000Z' },
  items: [
    {
      productId: ID.product,
      productCode: 'BASEUS-20W',
      unit: 'dona',
      name: 'Baseus 20W zaryadlovchi',
      price: '89000.00',
      deferredPrice: '87000.00',
      rrp: '109000.00',
      orderableStock: 45,
      currency: 'UZS',
      category: 'Зарядные устройства',
      imageUrl: null,
      imageLargeUrl: null,
    },
  ],
};

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function setup(answer: Response | (() => Response)) {
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(typeof answer === 'function' ? answer() : answer);
  });
  const onUnauthenticated = vi.fn();
  const http = createCustomerHttpClient({
    baseUrl: 'https://api.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    onUnauthenticated,
  });
  return { fetchImpl, onUnauthenticated, apis: createHttpCustomerApis(http) };
}

function sent(fetchImpl: ReturnType<typeof setup>['fetchImpl'], index = 0): [string, RequestInit] {
  return fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
}

beforeEach(() => {
  window.history.replaceState(null, '', `/#tgWebAppData=${encodeURIComponent(INIT_DATA)}`);
  captureLaunchParams();
});
afterEach(() => {
  forgetInitData();
  setCustomerToken(null);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Authorization header', () => {
  it('sends `Authorization: tma <initData>` on every call, unparsed', async () => {
    const { apis, fetchImpl } = setup(reply(200, ME));
    await apis.meApi.getMe();
    const [url, init] = sent(fetchImpl);
    expect(url).toBe('https://api.test/me');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: `tma ${INIT_DATA}` });
  });

  it('sends no Authorization header when the page was not opened from Telegram', async () => {
    forgetInitData();
    const { apis, fetchImpl } = setup(reply(200, ME));
    await apis.meApi.getMe();
    expect(sent(fetchImpl)[1].headers).not.toHaveProperty('Authorization');
  });

  it('reports a 401 to the session and still rejects the call', async () => {
    const { apis, onUnauthenticated } = setup(
      reply(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    await expect(apis.cartApi.get()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated).toHaveBeenCalledWith('telegram');
  });

  // Security review, 2026-11-10: the website token outlives the webview (localStorage), so a
  // sign-in made earlier on the device must never speak for the person Telegram names now.
  it('a token found in storage never wins over the init data of a Telegram launch', async () => {
    window.localStorage.setItem('iorder.customer.session', TOKEN);
    const { apis, fetchImpl } = setup(reply(200, ME));
    await apis.meApi.getMe();
    expect(sent(fetchImpl)[1].headers).toMatchObject({ Authorization: `tma ${INIT_DATA}` });
  });

  it('a refused init data (a forged fragment opened in a browser) leaves a stored token alone', async () => {
    window.localStorage.setItem('iorder.customer.session', TOKEN);
    const { apis, onUnauthenticated } = setup(
      reply(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    await expect(apis.cartApi.get()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(onUnauthenticated).toHaveBeenCalledWith('telegram');
    // The other tabs that use that token stay signed in.
    expect(window.localStorage.getItem('iorder.customer.session')).toBe(TOKEN);
  });

  it('a sign-in made in this tab wins over the init data; its 401 drops the token', async () => {
    setCustomerToken(TOKEN);
    const { apis, fetchImpl, onUnauthenticated } = setup(
      reply(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    await expect(apis.cartApi.get()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(sent(fetchImpl)[1].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(onUnauthenticated).toHaveBeenCalledWith('session');
    expect(readCustomerToken()).toBeNull();
  });

  it('outside Telegram a stored token is the credential, and its 401 drops it', async () => {
    forgetInitData();
    window.localStorage.setItem('iorder.customer.session', TOKEN);
    const { apis, fetchImpl, onUnauthenticated } = setup(
      reply(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    await expect(apis.cartApi.get()).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(sent(fetchImpl)[1].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(onUnauthenticated).toHaveBeenCalledWith('session');
    expect(window.localStorage.getItem('iorder.customer.session')).toBeNull();
  });

  it('does not treat a 403 as a lost session', async () => {
    const { apis, onUnauthenticated } = setup(
      reply(403, { error: { code: 'FORBIDDEN', message: 'x' } }),
    );
    await expect(apis.ordersApi.receive(ID.order)).rejects.not.toBeInstanceOf(UnauthenticatedError);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});

describe('me and the price list', () => {
  it('parses /me', async () => {
    const { apis } = setup(reply(200, ME));
    expect((await apis.meApi.getMe()).membership?.role).toBe('SHOP_OWNER');
  });

  it('PUT /me/contact sends the name and phone as JSON and parses the answer', async () => {
    const { apis, fetchImpl } = setup(reply(200, ME));
    const me = await apis.meApi.setContact({ fullName: 'Anvar Soliyev', phone: '+998901112233' });
    const [url, init] = sent(fetchImpl);
    expect(url).toBe('https://api.test/me/contact');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      fullName: 'Anvar Soliyev',
      phone: '+998901112233',
    });
    expect(me.needsContact).toBe(false);
  });

  it('asks for the price list in the given language and parses the customer DTO', async () => {
    const { apis, fetchImpl } = setup(reply(200, PRICE_LIST));
    const list = await apis.priceApi.getCurrent('RU');
    expect(sent(fetchImpl)[0]).toBe('https://api.test/price-list/current?lang=RU');
    expect(list.items[0]?.price).toBe('89000.00');
    // The recommended retail price is part of the customer DTO [C, 2026-11-09].
    expect(list.items[0]?.rrp).toBe('109000.00');
  });

  it('refuses a price list that carries a cost field (hard rule 7)', async () => {
    const leaky = {
      ...PRICE_LIST,
      items: [{ ...PRICE_LIST.items[0], costUsd: '10.00' }],
    };
    const { apis } = setup(reply(200, leaky));
    await expect(apis.priceApi.getCurrent('UZ')).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('a missing price list is a 404 error the page turns into an empty screen', async () => {
    const { apis } = setup(reply(404, { error: { code: 'NOT_FOUND', message: 'none' } }));
    await expect(apis.priceApi.getCurrent('UZ')).rejects.toBeInstanceOf(ApiNotFoundError);
  });
});

describe('cart', () => {
  it('reads the cart', async () => {
    const { apis, fetchImpl } = setup(reply(200, CART));
    const cart = await apis.cartApi.get();
    expect(sent(fetchImpl)[0]).toBe('https://api.test/cart');
    expect(cart.canSubmit).toBe(false);
    expect(cart.lines[1]?.problem).toBe('INACTIVE');
  });

  it('sets a quantity with PUT /cart/items/:productId and a string quantity', async () => {
    const { apis, fetchImpl } = setup(reply(200, CART));
    await apis.cartApi.setItem(ID.product, { quantity: '2.5' });
    const [url, init] = sent(fetchImpl);
    expect(url).toBe(`https://api.test/cart/items/${ID.product}`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"quantity":"2.5"}');
  });

  it('removes a line with DELETE and parses the returned cart', async () => {
    const { apis, fetchImpl } = setup(reply(200, { ...CART, lines: [], totalAmount: '0.00' }));
    const cart = await apis.cartApi.removeItem(ID.product);
    expect(sent(fetchImpl)[1].method).toBe('DELETE');
    expect(cart.lines).toEqual([]);
  });

  it('rejects a cart whose money is a number (hard rule 1)', async () => {
    const { apis } = setup(reply(200, { ...CART, totalAmount: 222500 }));
    await expect(apis.cartApi.get()).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('orders', () => {
  it('submits with the Idempotency-Key header and the chosen plan', async () => {
    const { apis, fetchImpl } = setup(reply(201, ORDER));
    const order = await apis.ordersApi.submit('9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', {
      paymentPlan: 'FULL',
      expectedTotalAmount: '100.00',
    });
    const [url, init] = sent(fetchImpl);
    expect(url).toBe('https://api.test/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Idempotency-Key': '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      Authorization: `tma ${INIT_DATA}`,
    });
    expect(init.body).toBe(JSON.stringify({ paymentPlan: 'FULL', expectedTotalAmount: '100.00' }));
    expect(order.orderNumber).toBe('IO-10001');
  });

  it('surfaces the conflict reasons of a submit', async () => {
    const conflict = (reason: string) =>
      reply(409, { error: { code: 'CONFLICT', message: 'x', reason } });
    for (const reason of [
      'IDEMPOTENCY_KEY_REUSED',
      'PRODUCT_NOT_ORDERABLE',
      'EMPTY_CART',
      'ORDERING_ORGANIZATION_INACTIVE',
      'CONTACT_REQUIRED',
    ]) {
      const { apis } = setup(conflict(reason));
      const error: unknown = await apis.ordersApi
        .submit('a-valid-key-1', { paymentPlan: 'FULL', expectedTotalAmount: '1.00' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiConflictError);
      expect((error as ApiConflictError).reason).toBe(reason);
    }
  });

  it('keeps a network failure distinguishable from an answer (the key must be kept)', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('offline')));
    const http = createCustomerHttpClient({
      baseUrl: 'https://api.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      createHttpCustomerApis(http).ordersApi.submit('a-valid-key-1', {
        paymentPlan: 'FULL',
        expectedTotalAmount: '1.00',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('lists with status and cursor and parses the page', async () => {
    const { apis, fetchImpl } = setup(
      reply(200, { orders: [ORDER_SUMMARY], nextCursor: ID.order }),
    );
    const page = await apis.ordersApi.list({ status: 'DELIVERED', cursor: ID.order, limit: 10 });
    const url = new URL(sent(fetchImpl)[0]);
    expect(url.pathname).toBe('/orders');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'DELIVERED',
      cursor: ID.order,
      limit: '10',
    });
    expect(page.nextCursor).toBe(ID.order);
  });

  it('reads an order and its timeline', async () => {
    const one = setup(reply(200, ORDER));
    expect((await one.apis.ordersApi.get(ID.order)).items).toHaveLength(1);
    expect(sent(one.fetchImpl)[0]).toBe(`https://api.test/orders/${ID.order}`);

    const two = setup(reply(200, TIMELINE));
    const timeline = await two.apis.ordersApi.timeline(ID.order);
    expect(sent(two.fetchImpl)[0]).toBe(`https://api.test/orders/${ID.order}/timeline`);
    expect(timeline.events[1]?.itemsChange?.lines[0]?.change).toBe('QUANTITY_CHANGED');
  });

  it('refuses a timeline event with a staff-only field', async () => {
    const leaky = {
      ...TIMELINE,
      events: [{ ...TIMELINE.events[0], accountingMode: 'SKIPPED_BY_MANAGER' }],
    };
    const { apis } = setup(reply(200, leaky));
    await expect(apis.ordersApi.timeline(ID.order)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('receives with an empty body by default', async () => {
    const { apis, fetchImpl } = setup(reply(200, { ...ORDER, status: 'RECEIVED' }));
    await apis.ordersApi.receive(ID.order);
    const [url, init] = sent(fetchImpl);
    expect(url).toBe(`https://api.test/orders/${ID.order}/receive`);
    expect(init.body).toBe('{}');
  });

  it('changes the plan with the version that was read', async () => {
    const { apis, fetchImpl } = setup(reply(200, ORDER));
    await apis.ordersApi.changePaymentPlan(ID.order, {
      paymentPlan: 'DEFERRED',
      expectedRowVersion: 3,
    });
    const [url, init] = sent(fetchImpl);
    expect(url).toBe(`https://api.test/orders/${ID.order}/payment-plan`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ paymentPlan: 'DEFERRED', expectedRowVersion: 3 }));
  });

  it('a foreign order is a 404, not a 403', async () => {
    const { apis } = setup(reply(404, { error: { code: 'NOT_FOUND', message: 'x' } }));
    await expect(apis.ordersApi.get(ID.order)).rejects.toBeInstanceOf(ApiNotFoundError);
  });
});
