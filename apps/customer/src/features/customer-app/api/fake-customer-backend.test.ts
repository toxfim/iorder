import {
  stockLimitExceededDetailsSchema,
  cartResponseSchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerPriceListResponseSchema,
  customerTimelineResponseSchema,
  meResponseSchema,
} from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
  UnauthenticatedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { CustomerOrder } from '@iorder/shared';
import { createFakeCustomerBackend } from './fake-customer-backend';
import { FAKE_PRODUCTS } from './fake-customer-data';

const NOW = new Date('2026-10-19T04:30:00.000Z');

function setup(initData: string | null = 'fake-owner', seedProblemCart = false) {
  let who = initData;
  const backend = createFakeCustomerBackend({
    clock: { now: () => NOW },
    initData: () => who,
    seedProblemCart,
    pageSize: 3,
  });
  return { ...backend, as: (next: string | null) => (who = next) };
}

const product = (code: string) => {
  const found = FAKE_PRODUCTS.find((p) => p.code === code);
  if (!found) throw new Error(code);
  return found;
};
// The ids the customer fake gives to its seeded orders.
const orderId = (number: number): string => fakeUuid(`customer-order:IO-${number}`);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e,
  );
}

type Fake = ReturnType<typeof createFakeCustomerBackend>;

/** Submits at the total the cart shows right now, like the cart page. */
async function submitShown(f: Fake, key: string): Promise<CustomerOrder> {
  const { totalAmount } = await f.cartApi.get();
  return f.ordersApi.submit(key, { paymentPlan: 'FULL', expectedTotalAmount: totalAmount });
}

describe('the fake answers in the shape of the real contract', () => {
  it('parses every response with the strict shared schemas', async () => {
    const f = setup('fake-seller', true);
    expect(meResponseSchema.safeParse(await f.meApi.getMe()).success).toBe(true);
    expect(
      customerPriceListResponseSchema.safeParse(await f.priceApi.getCurrent('UZ')).success,
    ).toBe(true);
    const cart = await f.cartApi.get();
    expect(cartResponseSchema.safeParse(cart).success).toBe(true);
    const page = await f.ordersApi.list({ limit: 100 });
    expect(customerOrderListResponseSchema.safeParse(page).success).toBe(true);
    for (const summary of page.orders) {
      const order = await f.ordersApi.get(summary.id);
      expect(customerOrderSchema.safeParse(order).success).toBe(true);
      const timeline = await f.ordersApi.timeline(summary.id);
      expect(customerTimelineResponseSchema.safeParse(timeline).success).toBe(true);
    }
  });

  it('the customer price list has no cost, only the category label and the one stock figure', async () => {
    const list = await setup().priceApi.getCurrent('UZ');
    for (const item of list.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'deferredPrice',
          'category',
          'currency',
          'imageLargeUrl',
          'imageUrl',
          'name',
          'orderableStock',
          'price',
          'productCode',
          'productId',
          'rrp',
          'unit',
        ].sort(),
      );
    }
    // The figure is a whole number of pieces where the demo has stock, 0 for a product that is out
    // of stock, and null where the stock is unknown (no figure, no cap).
    const stockOf = (code: string): number | null | undefined =>
      list.items.find((item) => item.productCode === code)?.orderableStock;
    expect([
      stockOf('BASEUS-20W'),
      stockOf('TECNO-POP8-64'),
      stockOf('UGREEN-65W-GAN'),
      stockOf('HOCO-GLASS-A15'),
    ]).toEqual([45, 0, null, null]);
    // Some demo products have a recommended retail price, most have none.
    const rrpOf = (code: string): string | null | undefined =>
      list.items.find((item) => item.productCode === code)?.rrp;
    expect(rrpOf('BASEUS-20W')).toBe('109000.00');
    expect(rrpOf('BOROFONE-BW05')).toBeNull();
  });
});

describe('who may call what', () => {
  it('an unknown person or a missing header is a 401 on everything, /me included', async () => {
    for (const who of [null, 'fake-nobody']) {
      const f = setup(who);
      expect(await failure(f.meApi.getMe())).toBeInstanceOf(UnauthenticatedError);
      expect(await failure(f.cartApi.get())).toBeInstanceOf(UnauthenticatedError);
      expect(await failure(f.ordersApi.list())).toBeInstanceOf(UnauthenticatedError);
    }
  });

  it('a staff viewer gets prices and a cart, nothing of any organization, and no order ([C] 2026-11-09)', async () => {
    const f = setup('fake-viewer');
    const me = meResponseSchema.parse(await f.meApi.getMe());
    expect(me.membership).toBeNull();
    expect(me.needsContact).toBe(false);
    expect(me.staffViewer).toEqual({ canOrder: false, organizationName: null });

    expect((await f.priceApi.getCurrent('UZ')).items.length).toBeGreaterThan(0);
    await f.cartApi.setItem(product('BASEUS-20W').id, { quantity: '2' });
    expect((await f.cartApi.get()).lines).toHaveLength(1);
    // The seeded orders of the organizations are not theirs to see.
    expect(await f.ordersApi.list()).toEqual({ orders: [], nextCursor: null });
    expect(await failure(f.ordersApi.get(orderId(10480)))).toBeInstanceOf(ApiNotFoundError);
    expect((await f.balanceApi.getBalance()).amountDue).toBe('0.00');

    const refused = await failure(submitShown(f, 'viewer-key-1'));
    expect(refused).toBeInstanceOf(ApiConflictError);
    expect((refused as ApiConflictError).reason).toBe('STAFF_ORDERING_DISABLED');
    expect((await f.cartApi.get()).lines).toHaveLength(1);
    expect(
      await failure(f.meApi.setContact({ fullName: 'A', phone: '+998935550147' })),
    ).toBeInstanceOf(PermissionDeniedError);

    // A customer's cart and orders are untouched by the viewer's.
    f.as('fake-owner');
    expect((await f.cartApi.get()).lines).toEqual([]);
    expect((await f.ordersApi.list()).orders.length).toBeGreaterThan(0);
  });

  it('a staff viewer with ordering on places a test order only they see', async () => {
    const f = setup('fake-viewer-ordering');
    expect((await f.meApi.getMe()).staffViewer?.canOrder).toBe(true);
    await f.cartApi.setItem(product('BASEUS-20W').id, { quantity: '1' });
    const placed = customerOrderSchema.parse(await submitShown(f, 'viewer-key-2'));
    expect(placed.paymentPlanChangeableUntil).toBeNull();
    expect((await f.ordersApi.list()).orders.map((order) => order.id)).toEqual([placed.id]);
    expect(await failure(f.ordersApi.receive(placed.id, {}))).toBeInstanceOf(PermissionDeniedError);

    for (const other of ['fake-viewer', 'fake-owner', 'fake-other-org']) {
      f.as(other);
      expect(await failure(f.ordersApi.get(placed.id))).toBeInstanceOf(ApiNotFoundError);
    }
  });

  it('a staff member and a member of an inactive organization get no customer data', async () => {
    for (const who of ['fake-staff', 'fake-inactive-org']) {
      const f = setup(who);
      const me = await f.meApi.getMe();
      expect(me.membership).toBeNull();
      expect(await failure(f.cartApi.get())).toBeInstanceOf(PermissionDeniedError);
      expect(await failure(f.ordersApi.list())).toBeInstanceOf(PermissionDeniedError);
      expect(await failure(f.priceApi.getCurrent('UZ'))).toBeInstanceOf(PermissionDeniedError);
    }
  });
});

describe('organization isolation', () => {
  it('lists only the own organization, and a foreign order is a 404 on every read and write', async () => {
    const f = setup('fake-owner');
    const own = await f.ordersApi.list({ limit: 100 });
    expect(own.orders.map((o) => o.orderNumber)).not.toContain('IO-10460');

    const foreign = orderId(10460);
    expect(await failure(f.ordersApi.get(foreign))).toBeInstanceOf(ApiNotFoundError);
    expect(await failure(f.ordersApi.timeline(foreign))).toBeInstanceOf(ApiNotFoundError);
    expect(await failure(f.ordersApi.receive(foreign))).toBeInstanceOf(ApiNotFoundError);

    f.as('fake-other-org');
    expect((await f.ordersApi.list()).orders.map((o) => o.orderNumber)).toEqual(['IO-10460']);
  });

  it('carts are per person', async () => {
    const f = setup('fake-owner');
    await f.cartApi.setItem(product('BASEUS-20W').id, { quantity: '2' });
    f.as('fake-seller');
    expect((await f.cartApi.get()).lines).toEqual([]);
  });
});

describe('cart rules', () => {
  it('prices the cart on the server and keeps quantities as strings', async () => {
    const f = setup();
    const cart = await f.cartApi.setItem(product('BASEUS-20W').id, { quantity: '3' });
    expect(cart.lines[0]).toMatchObject({ quantity: '3', lineTotal: '267000.00' });
    expect(cart.totalAmount).toBe('267000.00');
    expect(cart.canSubmit).toBe(true);
  });

  it.each(['0', '-1', '2.5', '1.2345', 'abc', '1e3', ''])(
    'rejects the quantity %j with a 422',
    async (q) => {
      const f = setup();
      expect(
        await failure(f.cartApi.setItem(product('BASEUS-20W').id, { quantity: q })),
      ).toBeInstanceOf(ApiValidationError);
    },
  );

  it('refuses an inactive or unpriced product with PRODUCT_NOT_ORDERABLE', async () => {
    const f = setup();
    for (const code of ['OLD-CHARGER-5W', 'NEW-POWERBANK']) {
      const error = await failure(f.cartApi.setItem(product(code).id, { quantity: '1' }));
      expect(error).toBeInstanceOf(ApiConflictError);
      expect((error as ApiConflictError).reason).toBe('PRODUCT_NOT_ORDERABLE');
    }
  });

  it('a product that goes inactive stays in the cart flagged and blocks submission', async () => {
    const f = setup();
    await f.cartApi.setItem(product('BASEUS-20W').id, { quantity: '1' });
    f.deactivateProduct('BASEUS-20W');
    const cart = await f.cartApi.get();
    expect(cart.lines[0]).toMatchObject({ problem: 'INACTIVE', unitPrice: null, lineTotal: null });
    expect(cart.canSubmit).toBe(false);
    const error = await failure(submitShown(f, 'key-for-blocked-cart'));
    expect((error as ApiConflictError).reason).toBe('PRODUCT_NOT_ORDERABLE');
  });

  it('removing a line that is not there is not an error', async () => {
    const f = setup();
    expect((await f.cartApi.removeItem(product('HOCO-USBC-1M').id)).lines).toEqual([]);
  });
});

describe('the stock cap, like the server (owner decision 2026-11-09)', () => {
  const baseus = product('BASEUS-20W');
  const ugreen = product('UGREEN-65W-GAN');

  const refusal = async (promise: Promise<unknown>): Promise<ApiConflictError> => {
    const error = await failure(promise);
    expect(error).toBeInstanceOf(ApiConflictError);
    return error as ApiConflictError;
  };

  it('refuses a quantity above the figure with the current figure and keeps the cart', async () => {
    const f = setup();
    await f.cartApi.setItem(baseus.id, { quantity: '45' });
    const error = await refusal(f.cartApi.setItem(baseus.id, { quantity: '46' }));
    expect(error.reason).toBe('STOCK_LIMIT_EXCEEDED');
    expect(stockLimitExceededDetailsSchema.parse(error.details).lines).toEqual([
      { productId: baseus.id, orderableStock: 45 },
    ]);
    const cart = await f.cartApi.get();
    expect(cart.lines[0]).toMatchObject({ quantity: '45', orderableStock: 45, problem: null });
    expect(cart.canSubmit).toBe(true);
  });

  it('a product without a figure has no cap', async () => {
    const f = setup();
    const cart = await f.cartApi.setItem(ugreen.id, { quantity: '5000' });
    expect(cart.lines[0]).toMatchObject({ orderableStock: null, problem: null });
    f.setStock('BASEUS-20W', null);
    const uncapped = await f.cartApi.setItem(baseus.id, { quantity: '900' });
    expect(uncapped.lines.map((line) => line.orderableStock)).toEqual([null, null]);
    expect(uncapped.canSubmit).toBe(true);
    const list = await f.priceApi.getCurrent('UZ');
    expect(list.items.find((item) => item.productId === baseus.id)?.orderableStock).toBeNull();
  });

  it('out of stock (a figure of 0) cannot be put in the cart; a line it ran out under must go', async () => {
    const f = setup();
    const pop = product('TECNO-POP8-64');
    const refused = await refusal(f.cartApi.setItem(pop.id, { quantity: '1' }));
    expect(refused.reason).toBe('STOCK_LIMIT_EXCEEDED');
    expect(stockLimitExceededDetailsSchema.parse(refused.details).lines).toEqual([
      { productId: pop.id, orderableStock: 0 },
    ]);
    expect((await f.cartApi.get()).lines).toEqual([]);

    await f.cartApi.setItem(baseus.id, { quantity: '3' });
    f.setStock('BASEUS-20W', 0);
    const cart = await f.cartApi.get();
    expect(cart.lines[0]).toMatchObject({
      quantity: '3',
      unitPrice: '89000.00',
      orderableStock: 0,
      problem: 'STOCK_EXCEEDED',
    });
    expect(cart.canSubmit).toBe(false);
    expect((await refusal(f.cartApi.setItem(baseus.id, { quantity: '1' }))).reason).toBe(
      'STOCK_LIMIT_EXCEEDED',
    );
    expect((await refusal(submitShown(f, 'stock-key-0003'))).reason).toBe('STOCK_LIMIT_EXCEEDED');
    const without = await f.cartApi.removeItem(baseus.id);
    expect(without.lines).toEqual([]);
  });

  it('a line above a fallen stock keeps its prices, blocks the order and is refused at submit', async () => {
    const f = setup();
    await f.cartApi.setItem(baseus.id, { quantity: '10' });
    f.setStock('BASEUS-20W', 4);
    const cart = await f.cartApi.get();
    expect(cartResponseSchema.safeParse(cart).success).toBe(true);
    expect(cart.lines[0]).toMatchObject({
      quantity: '10',
      unitPrice: '89000.00',
      lineTotal: '890000.00',
      orderableStock: 4,
      problem: 'STOCK_EXCEEDED',
    });
    expect([cart.totalAmount, cart.canSubmit]).toEqual(['890000.00', false]);

    const refused = await refusal(submitShown(f, 'stock-key-0001'));
    expect(refused.reason).toBe('STOCK_LIMIT_EXCEEDED');
    expect(stockLimitExceededDetailsSchema.parse(refused.details).lines).toEqual([
      { productId: baseus.id, orderableStock: 4 },
    ]);
    // Lowering, but not far enough, is refused too; the figure itself goes through.
    expect((await refusal(f.cartApi.setItem(baseus.id, { quantity: '7' }))).reason).toBe(
      'STOCK_LIMIT_EXCEEDED',
    );
    const fixed = await f.cartApi.setItem(baseus.id, { quantity: '4' });
    expect(fixed.lines[0]).toMatchObject({ quantity: '4', problem: null });
    const order = await submitShown(f, 'stock-key-0002');
    expect(order.items.map((item) => item.quantity)).toEqual(['4']);
  });
});

describe('submit and idempotency', () => {
  it('an empty cart is EMPTY_CART', async () => {
    const f = setup();
    const error = await failure(submitShown(f, 'key-for-empty-cart'));
    expect((error as ApiConflictError).reason).toBe('EMPTY_CART');
  });

  it('creates an order with a price snapshot, empties the cart and numbers it', async () => {
    const f = setup();
    await f.cartApi.setItem(product('HOCO-USBC-1M').id, { quantity: '4' });
    const order = await submitShown(f, 'key-first-order-1');
    expect(order).toMatchObject({
      status: 'SUBMITTED',
      paymentStatus: 'UNPAID',
      totalAmount: '74000.00',
      placedByMe: true,
    });
    expect(order.items[0]).toMatchObject({ unitPrice: '18500.00', lineTotal: '74000.00' });
    expect((await f.cartApi.get()).lines).toEqual([]);
    expect((await f.ordersApi.list()).orders[0]?.id).toBe(order.id);
  });

  it('the same key returns the same order, even after the cart was refilled', async () => {
    const f = setup();
    await f.cartApi.setItem(product('HOCO-USBC-1M').id, { quantity: '4' });
    const first = await submitShown(f, 'key-retry-after-drop');
    await f.cartApi.setItem(product('BASEUS-20W').id, { quantity: '1' });
    const again = await submitShown(f, 'key-retry-after-drop');
    expect(again.id).toBe(first.id);
    const all = await f.ordersApi.list({ limit: 100 });
    expect(all.orders.filter((o) => o.id === first.id)).toHaveLength(1);
  });

  it('a colleague reusing the key gets IDEMPOTENCY_KEY_REUSED; another organization does not', async () => {
    const f = setup('fake-owner');
    await f.cartApi.setItem(product('HOCO-USBC-1M').id, { quantity: '1' });
    await submitShown(f, 'key-shared-by-two');

    f.as('fake-seller');
    await f.cartApi.setItem(product('HOCO-USBC-1M').id, { quantity: '1' });
    const error = await failure(submitShown(f, 'key-shared-by-two'));
    expect((error as ApiConflictError).reason).toBe('IDEMPOTENCY_KEY_REUSED');

    f.as('fake-other-org');
    await f.cartApi.setItem(product('HOCO-USBC-1M').id, { quantity: '1' });
    await expect(submitShown(f, 'key-shared-by-two')).resolves.toMatchObject({
      status: 'SUBMITTED',
    });
  });

  it('refuses a key that is too short or has unsafe characters with a 422', async () => {
    const f = setup();
    for (const key of ['short', 'has spaces in it', 'x'.repeat(129)]) {
      expect(await failure(submitShown(f, key))).toBeInstanceOf(ApiValidationError);
    }
  });
});

describe('reading orders', () => {
  it('pages with a cursor, newest first, without repeats, and filters by status', async () => {
    const f = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.ordersApi.list({ cursor });
      expect(page.orders.length).toBeLessThanOrEqual(3);
      seen.push(...page.orders.map((o) => o.orderNumber));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe('IO-10491');

    const delivered = await f.ordersApi.list({ status: 'DELIVERED' });
    expect(delivered.orders.map((o) => o.status)).toEqual(['DELIVERED', 'DELIVERED']);
    expect(delivered.nextCursor).toBeNull();
  });

  it('the timeline shows roles and names only for the own organization, with reasons as written', async () => {
    const f = setup();
    const rejected = await f.ordersApi.timeline(orderId(10470));
    const closing = rejected.events.find((e) => e.toStatus === 'REJECTED');
    expect(closing).toMatchObject({
      comment: 'Bu model omborda tugagan',
      actor: { role: 'MANAGER', name: null },
    });
    const received = await f.ordersApi.timeline(orderId(10480));
    expect(received.events.some((e) => e.type === 'ITEMS_EDITED')).toBe(true);
    expect(received.events.some((e) => e.paymentChange?.to === 'PAID')).toBe(true);
  });
});

describe('cancel', () => {
  it('the customer API has no cancel at all', () => {
    const f = setup();
    expect('cancel' in f.ordersApi).toBe(false);
  });
});

describe('the contact entered at the first order', () => {
  it('me shows needsContact for a newcomer and the own contact for the others', async () => {
    const newcomer = await setup('fake-newcomer').meApi.getMe();
    expect(newcomer).toMatchObject({ contact: null, needsContact: true });
    const owner = await setup('fake-owner').meApi.getMe();
    expect(owner.needsContact).toBe(false);
    expect(owner.contact?.phone).toBe('+998901112233');
    // A colleague's phone is never part of anyone else's answer.
    expect(JSON.stringify(newcomer)).not.toContain('998901112233');
  });

  it('refuses the first submit with CONTACT_REQUIRED, then accepts after the contact is set', async () => {
    const f = setup('fake-newcomer');
    await f.cartApi.setItem(product('HOCO-USBC-1M').id, { quantity: '1' });
    const refused = await failure(submitShown(f, 'key-needs-contact'));
    expect((refused as ApiConflictError).reason).toBe('CONTACT_REQUIRED');
    const me = await f.meApi.setContact({ fullName: 'Dilshod K', phone: '+998 93 555 0147' });
    expect(me).toMatchObject({ needsContact: false, contact: { phone: '+998935550147' } });
    expect((await submitShown(f, 'key-needs-contact')).status).toBe('SUBMITTED');
  });

  it('can be changed afterwards: the later name and phone replace the earlier ones', async () => {
    const f = setup('fake-newcomer');
    const request = { fullName: 'Dilshod K', phone: '+998935550147' };
    await f.meApi.setContact(request);
    await f.meApi.setContact(request);
    const changed = await f.meApi.setContact({
      fullName: 'Dilshod Karimov',
      phone: '+998 90 123 45 67',
    });
    expect(changed).toMatchObject({
      fullName: 'Dilshod Karimov',
      contact: { fullName: 'Dilshod Karimov', phone: '+998901234567' },
      needsContact: false,
    });
    expect((await f.meApi.getMe()).contact?.phone).toBe('+998901234567');
  });

  it('rejects a bad phone and staff', async () => {
    const f = setup('fake-newcomer');
    expect(await failure(f.meApi.setContact({ fullName: 'A', phone: '123' }))).toBeInstanceOf(
      ApiValidationError,
    );
    f.as('fake-staff');
    expect(
      await failure(f.meApi.setContact({ fullName: 'A', phone: '+998935550147' })),
    ).toBeInstanceOf(PermissionDeniedError);
  });
});

describe('receive', () => {
  it('the shop owner confirms any delivered order of the organization', async () => {
    const f = setup('fake-owner');
    await expect(f.ordersApi.receive(orderId(10488))).resolves.toMatchObject({
      status: 'RECEIVED',
    });
  });

  it('a seller confirms only an order they placed (403 otherwise)', async () => {
    const f = setup('fake-seller');
    expect(await failure(f.ordersApi.receive(orderId(10487)))).toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(f.ordersApi.receive(orderId(10488))).resolves.toMatchObject({
      status: 'RECEIVED',
    });
  });

  it('is refused unless the order is DELIVERED', async () => {
    const f = setup('fake-owner');
    const error = await failure(f.ordersApi.receive(orderId(10489)));
    expect((error as ApiConflictError).reason).toBe('ILLEGAL_ORDER_TRANSITION');
  });
});
