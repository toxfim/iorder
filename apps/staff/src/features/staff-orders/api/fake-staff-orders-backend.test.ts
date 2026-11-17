import { fifoPlanOf } from './fake-allocation';
import { customerTimelineResponseSchema, type StaffRole } from '@iorder/shared';
import {
  staffOrderListResponseSchema,
  staffOrderSchema,
  staffTimelineResponseSchema,
  type StaffOrder,
  type StaffOrderSummary,
} from '@iorder/shared/staff-orders';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeOrderId, fakeUuid } from '@core/lib/fake-ids';
import { FAKE_PRODUCT_SEEDS } from '@/features/pricing/api/fake-price-fixtures';
import { createFakeStaffOrders } from './fake-staff-orders-backend';

// The fake must behave like the server, not just look like it: this is its own contract test.
// Every payload is parsed with the SAME strict schemas the HTTP adapter uses.

const WHO = {
  manager: { name: 'Aziza Yusupova', roles: ['MANAGER'] },
  admin: { name: 'Sanjar Toshev', roles: ['ADMIN'] },
  accountant: { name: 'Nodira Xasanova', roles: ['ACCOUNTANT'] },
  warehouse: { name: 'Rustam Qodirov', roles: ['WAREHOUSE_MANAGER'] },
  driver: { name: 'Bekzod Tursunov', roles: ['DRIVER'] },
} as const satisfies Record<string, { name: string; roles: readonly StaffRole[] }>;
type Who = keyof typeof WHO;

function setup() {
  let current: Who = 'manager';
  const activity: string[] = [];
  const fake = createFakeStaffOrders({
    clock: { now: () => new Date('2026-10-19T04:30:00.000Z') },
    actor: () => WHO[current],
    recordActivity: (kind) => activity.push(kind),
  });
  const as = <T>(who: Who, work: () => Promise<T>): Promise<T> => {
    current = who;
    return work();
  };
  return { ...fake, as, activity };
}

const id = fakeOrderId;
const SUBMITTED = id('IO-10491');
const APPROVED = id('IO-10489');
const CLEARED = id('IO-10484'); // manager skipped accounting
const RELEASED = id('IO-10488'); // driver Bekzod
const DELIVERED = id('IO-10477');

const reasonOf = (error: unknown) => (error as ApiConflictError).reason;

describe('what each role sees', () => {
  it('parses every list, order and timeline for every role with the shared strict schemas', async () => {
    const { ordersApi, as } = setup();
    for (const who of Object.keys(WHO) as Who[]) {
      const list = await as(who, () => ordersApi.listOrders({ limit: 100 }));
      expect(() => staffOrderListResponseSchema.parse(list)).not.toThrow();
      for (const summary of list.orders) {
        const order = await as(who, () => ordersApi.getOrder(summary.id));
        expect(() => staffOrderSchema.parse(order)).not.toThrow();
        const timeline = await as(who, () => ordersApi.getTimeline(summary.id));
        expect(() => staffTimelineResponseSchema.parse(timeline)).not.toThrow();
      }
    }
  });

  it('F-16: every order line carries the price list product code, for every role', async () => {
    const { ordersApi, as } = setup();
    for (const who of Object.keys(WHO) as Who[]) {
      const list = await as(who, () => ordersApi.listOrders({ limit: 100 }));
      for (const summary of list.orders) {
        const order = await as(who, () => ordersApi.getOrder(summary.id));
        for (const item of order.items) {
          expect(
            FAKE_PRODUCT_SEEDS.some((p) => p.productCode === item.productCode),
            `${who}: ${item.productCode} is not a price list code`,
          ).toBe(true);
        }
      }
    }
  });

  it('gives manager, accountant and admin the FULL view and warehouse and driver the FULFILMENT view', async () => {
    const { ordersApi, as } = setup();
    for (const who of ['manager', 'accountant', 'admin'] as const) {
      expect((await as(who, () => ordersApi.getOrder(CLEARED))).detail).toBe('FULL');
    }
    for (const who of ['warehouse', 'driver'] as const) {
      const order = await as(who, () => ordersApi.getOrder(who === 'driver' ? RELEASED : CLEARED));
      expect(order.detail).toBe('FULFILMENT');
      // no prices, totals, payment, accounting or price list version anywhere in the payload
      const text = JSON.stringify(order);
      for (const secret of [
        'unitPrice',
        'lineTotal',
        'totalAmount',
        'paymentStatus',
        'accounting',
        'priceListVersionId',
        'placedBy',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('shows the accountant no phone number and no delivery contact', async () => {
    const { ordersApi, as } = setup();
    const order = await as('accountant', () => ordersApi.getOrder(RELEASED));
    expect(order.detail === 'FULL' && order.deliveryContact).toBeNull();
    const list = await as('accountant', () => ordersApi.listOrders({ limit: 100 }));
    const texts = JSON.stringify([
      order,
      list,
      await as('accountant', () => ordersApi.getTimeline(RELEASED)),
    ]);
    expect(texts).not.toMatch(/\+998/);
    expect(order.driver?.phone).toBeNull();
    // the manager gets the same people with their phones
    const manager = await as('manager', () => ordersApi.getOrder(RELEASED));
    expect(manager.driver?.phone).toMatch(/^\+998/);
    expect(manager.deliveryContact?.contacts.some((c) => c.phone)).toBe(true);
  });

  it('gives the warehouse the delivery contact with phones, the placer and the shop owner', async () => {
    const { ordersApi, as } = setup();
    const order = await as('warehouse', () => ordersApi.getOrder(CLEARED));
    if (order.detail !== 'FULFILMENT') throw new Error('expected the fulfilment view');
    expect(order.deliveryContact.organizationName).toBe('Click Store');
    expect(order.deliveryContact.contacts.every((c) => c.phone !== null)).toBe(true);
    expect(order.deliveryContact.contacts.some((c) => c.placedTheOrder)).toBe(true);
  });

  it('limits the warehouse to approved orders and the driver to assigned ones (404 otherwise)', async () => {
    const { ordersApi, as } = setup();
    const warehouse = await as('warehouse', () => ordersApi.listOrders({ limit: 100 }));
    expect(warehouse.orders.every((o) => o.status !== 'SUBMITTED')).toBe(true);
    expect(warehouse.orders.some((o) => o.status === 'MANAGER_APPROVED')).toBe(true);
    expect(warehouse.orders.length).toBeGreaterThan(0);
    await expect(as('warehouse', () => ordersApi.getOrder(SUBMITTED))).rejects.toBeInstanceOf(
      ApiNotFoundError,
    );
    const driver = await as('driver', () => ordersApi.listOrders({ limit: 100 }));
    expect(driver.orders.map((o) => o.driver?.fullName)).toEqual(
      driver.orders.map(() => 'Bekzod Tursunov'),
    );
    await expect(as('driver', () => ordersApi.getOrder(CLEARED))).rejects.toBeInstanceOf(
      ApiNotFoundError,
    );
  });

  it('pages with a cursor and filters by status, payment and number', async () => {
    const { ordersApi } = setup();
    const first = await ordersApi.listOrders({ limit: 5 });
    expect(first.orders).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();
    const second = await ordersApi.listOrders({ limit: 5, cursor: first.nextCursor ?? undefined });
    expect(second.orders[0]?.id).not.toBe(first.orders[0]?.id);
    const submitted = await ordersApi.listOrders({ status: 'SUBMITTED' });
    expect(submitted.orders.map((o: StaffOrderSummary) => o.orderNumber)).toEqual([
      'IO-10491',
      'IO-10490',
      'IO-10487',
    ]);
    expect((await ordersApi.listOrders({ search: 'io-10489' })).orders).toHaveLength(1);
  });
});

describe('commands decide like the server', () => {
  it('requires the row version the person saw: a stale one is 409 ORDER_CHANGED and changes nothing', async () => {
    const { ordersApi, as } = setup();
    const order = await ordersApi.getOrder(SUBMITTED);
    await ordersApi.approve(SUBMITTED, {
      ...(await fifoPlanOf(ordersApi, SUBMITTED)),
      paymentMethod: 'CASH',
      expectedRowVersion: order.rowVersion,
    });
    // a second person decided on the same version
    const stale = await ordersApi
      .reject(SUBMITTED, { reason: 'Kech qoldi', expectedRowVersion: order.rowVersion })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ApiConflictError);
    expect(reasonOf(stale)).toBe('ORDER_CHANGED');
    const now = await as('manager', () => ordersApi.getOrder(SUBMITTED));
    expect(now.status).toBe('MANAGER_APPROVED');
    expect(now.rowVersion).toBe(order.rowVersion + 1);
  });

  it('answers a decision that comes too late with ORDER_CHANGED, a nonsense move with ILLEGAL_ORDER_TRANSITION', async () => {
    const { ordersApi, as } = setup();
    const approved = await ordersApi.getOrder(APPROVED);
    // the manager approves an order that already is approved: someone got there first
    const late = await ordersApi
      .approve(APPROVED, {
        paymentMethod: 'CASH',
        allocationMode: 'FIFO',
        allocations: [],
        expectedRowVersion: approved.rowVersion,
      })
      .catch((e: unknown) => e);
    expect(reasonOf(late)).toBe('ORDER_CHANGED');
    // cancelling after the goods left the warehouse is not a move the lifecycle has
    const released = await ordersApi.getOrder(RELEASED);
    const illegal = await ordersApi
      .cancel(RELEASED, { reason: 'Kech', expectedRowVersion: released.rowVersion })
      .catch((e: unknown) => e);
    expect(reasonOf(illegal)).toBe('ILLEGAL_ORDER_TRANSITION');
    // a move that exists, but not for this role, is forbidden rather than illegal
    const submitted = await ordersApi.getOrder(SUBMITTED);
    await expect(
      as('accountant', () =>
        ordersApi.accountingReject(SUBMITTED, {
          reason: 'Limit',
          expectedRowVersion: submitted.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('needs a reason for every reject and cancel (422 on reason) and keeps the order untouched', async () => {
    const { ordersApi, as } = setup();
    const submitted = await ordersApi.getOrder(SUBMITTED);
    for (const attempt of [
      () =>
        ordersApi.reject(SUBMITTED, { reason: '   ', expectedRowVersion: submitted.rowVersion }),
      () => ordersApi.cancel(SUBMITTED, { reason: '', expectedRowVersion: submitted.rowVersion }),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiValidationError);
      expect((error as ApiValidationError).issues[0]?.path).toBe('reason');
    }
    const approved = await ordersApi.getOrder(APPROVED);
    const rejection = await as('accountant', () =>
      ordersApi.accountingReject(APPROVED, {
        reason: '  ',
        expectedRowVersion: approved.rowVersion,
      }),
    ).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ApiValidationError);
    expect((await ordersApi.getOrder(SUBMITTED)).status).toBe('SUBMITTED');
  });

  it('tells the warehouse to prepare on a normal approval, as the server does', async () => {
    const { ordersApi, as } = setup();
    const before = await ordersApi.getOrder(SUBMITTED);
    await ordersApi.approve(SUBMITTED, {
      ...(await fifoPlanOf(ordersApi, SUBMITTED)),
      paymentMethod: 'CASH',
      expectedRowVersion: before.rowVersion,
    });
    const { events } = await ordersApi.getTimeline(SUBMITTED);
    expect(events.at(-1)?.notifications.map((n) => n.type)).toContain('ORDER_READY_TO_PREPARE');

    // the warehouse's words on the return stay in the history, as on the server
    const approved = await ordersApi.getOrder(SUBMITTED);
    const cancelled = await ordersApi.cancel(SUBMITTED, {
      reason: 'Mijoz aytdi',
      expectedRowVersion: approved.rowVersion,
    });
    await as('warehouse', () =>
      ordersApi.markGoodsReturned(SUBMITTED, {
        comment: ' Javonga qaytdi ',
        expectedRowVersion: cancelled.rowVersion,
      }),
    );
    const after = await as('manager', () => ordersApi.getTimeline(SUBMITTED));
    expect(after.events.find((e) => e.type === 'GOODS_RETURNED')?.comment).toBe('Javonga qaytdi');
  });

  it('lets only the manager skip accounting, as an option of approve, in two events and one version step', async () => {
    const { ordersApi, as, customerTimeline } = setup();
    const before = await ordersApi.getOrder(SUBMITTED);
    const after = await ordersApi.approve(SUBMITTED, {
      ...(await fifoPlanOf(ordersApi, SUBMITTED)),
      skipAccounting: true,
      paymentMethod: 'OFFICIAL',
      expectedRowVersion: before.rowVersion,
    });
    expect(after.status).toBe('ACCOUNTING_CLEARED');
    expect(after.rowVersion).toBe(before.rowVersion + 1);
    expect(after.detail === 'FULL' && after.accounting.mode).toBe('SKIPPED_BY_MANAGER');
    const staff = await ordersApi.getTimeline(SUBMITTED);
    expect(staff.events.slice(-2).map((e) => [e.type, e.toStatus, e.actor.role])).toEqual([
      ['STATUS_CHANGED', 'MANAGER_APPROVED', 'MANAGER'],
      ['ACCOUNTING_SKIPPED', 'ACCOUNTING_CLEARED', 'MANAGER'],
    ]);
    expect(staff.events.at(-1)?.accountingMode).toEqual({
      from: 'PENDING',
      to: 'SKIPPED_BY_MANAGER',
    });
    // the warehouse sees a plain manager move, the customer too: a skip cannot be inferred
    const warehouse = await as('warehouse', () => ordersApi.getTimeline(SUBMITTED));
    expect(warehouse.events.at(-1)?.type).toBe('STATUS_CHANGED');
    expect(warehouse.events.at(-1)?.accountingMode).toBeNull();
    const customer = customerTimeline(SUBMITTED);
    expect(customer.events.length).toBeGreaterThan(1);
    expect(JSON.stringify(customer)).not.toMatch(/SKIPPED|accountingMode/);
    expect(customer.events.at(-1)?.actor?.role).toBe('MANAGER');
    // the accountant is told: it is in the list as a skipped order
    const list = await as('accountant', () => ordersApi.listOrders({ limit: 100 }));
    expect(
      list.orders.filter((o) => o.detail === 'FULL' && o.accounting.mode === 'SKIPPED_BY_MANAGER'),
    ).toHaveLength(2);
  });

  it('gives the admin no workflow step and no cancel, only payment', async () => {
    const { ordersApi, as } = setup();
    const deny = async (work: () => Promise<StaffOrder>) =>
      expect(await as('admin', work).catch((e: unknown) => e)).toBeInstanceOf(
        PermissionDeniedError,
      );
    await deny(() =>
      ordersApi.approve(SUBMITTED, {
        allocationMode: 'FIFO',
        allocations: [],
        paymentMethod: 'CASH',
        expectedRowVersion: 1,
      }),
    );
    await deny(() => ordersApi.reject(SUBMITTED, { reason: 'x', expectedRowVersion: 1 }));
    await deny(() => ordersApi.accountingApprove(APPROVED, { expectedRowVersion: 1 }));
    await deny(() =>
      ordersApi.release(CLEARED, { driverUserId: fakeUuid('s-06'), expectedRowVersion: 1 }),
    );
    await deny(() => ordersApi.deliver(RELEASED, { expectedRowVersion: 1 }));
    await deny(() =>
      ordersApi.editItems(SUBMITTED, { changes: [], expectedRowVersion: 1 } as never),
    );
    // Only the manager cancels (owner rule 2026-10-22): the admin gets the same 403 as the server.
    const submitted = await ordersApi.getOrder(SUBMITTED);
    await deny(() =>
      ordersApi.cancel(SUBMITTED, {
        reason: 'Mijoz so‘rovi',
        expectedRowVersion: submitted.rowVersion,
      }),
    );
    expect((await ordersApi.getOrder(SUBMITTED)).status).toBe('SUBMITTED');
  });

  it('keeps each step with its own role', async () => {
    const { ordersApi, as } = setup();
    const approved = await ordersApi.getOrder(APPROVED);
    await expect(
      as('manager', () =>
        ordersApi.accountingApprove(APPROVED, { expectedRowVersion: approved.rowVersion }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const cleared = await as('accountant', () =>
      ordersApi.accountingApprove(APPROVED, { expectedRowVersion: approved.rowVersion }),
    );
    expect(cleared.status).toBe('ACCOUNTING_CLEARED');
    expect(cleared.detail === 'FULL' && cleared.accounting.mode).toBe('APPROVED');
  });

  it('releases with an active driver only, then lets that driver (and nobody else) deliver', async () => {
    const { ordersApi, driversApi, as } = setup();
    const drivers = await driversApi.listActiveDrivers();
    expect(drivers.map((d) => d.fullName)).toEqual(['Bekzod Tursunov', 'Sherzod Aliyev']);
    const cleared = await as('warehouse', () => ordersApi.getOrder(CLEARED));
    const notADriver = await as('warehouse', () =>
      ordersApi.release(CLEARED, {
        driverUserId: fakeUuid('s-02'),
        expectedRowVersion: cleared.rowVersion,
      }),
    ).catch((e: unknown) => e);
    expect(notADriver).toBeInstanceOf(ApiValidationError);
    expect((notADriver as ApiValidationError).issues[0]?.path).toBe('driverUserId');
    const released = await as('warehouse', () =>
      ordersApi.release(CLEARED, {
        driverUserId: drivers[1]?.id ?? '',
        expectedRowVersion: cleared.rowVersion,
      }),
    );
    expect(released.status).toBe('RELEASED');
    expect(released.driver?.fullName).toBe('Sherzod Aliyev');
    // Bekzod is not the assigned driver: the order does not even exist for him
    await expect(
      as('driver', () => ordersApi.deliver(CLEARED, { expectedRowVersion: released.rowVersion })),
    ).rejects.toBeInstanceOf(ApiNotFoundError);
    const mine = await as('driver', () => ordersApi.getOrder(RELEASED));
    const done = await as('driver', () =>
      ordersApi.deliver(RELEASED, {
        comment: ' Eshik oldida ',
        expectedRowVersion: mine.rowVersion,
      }),
    );
    expect(done.status).toBe('DELIVERED');
    const history = await as('driver', () => ordersApi.getTimeline(RELEASED));
    expect(history.events.at(-1)?.comment).toBe('Eshik oldida');
  });

  it('edits items only while SUBMITTED, as one event, one version step and one customer message', async () => {
    const { ordersApi } = setup();
    const order = await ordersApi.getOrder(SUBMITTED);
    if (order.detail !== 'FULL') throw new Error('FULL expected');
    const [first, second] = order.items;
    if (!first || !second) throw new Error('two lines expected');

    const stale = await ordersApi
      .editItems(SUBMITTED, {
        changes: [{ itemId: first.id, quantity: '9' }],
        expectedRowVersion: order.rowVersion + 5,
      })
      .catch((e: unknown) => e);
    expect(reasonOf(stale)).toBe('ORDER_CHANGED');
    const unknown = await ordersApi
      .editItems(SUBMITTED, {
        changes: [{ itemId: fakeUuid('nope'), quantity: '1' }],
        expectedRowVersion: order.rowVersion,
      })
      .catch((e: unknown) => e);
    expect((unknown as ApiValidationError).issues[0]?.path).toBe('changes.0.itemId');

    const edited = await ordersApi.editItems(SUBMITTED, {
      changes: [
        { itemId: first.id, quantity: '9' },
        { itemId: second.id, quantity: null },
      ],
      reason: 'Tovar qolmagan',
      expectedRowVersion: order.rowVersion,
    });
    expect(edited.rowVersion).toBe(order.rowVersion + 1);
    expect(edited.itemCount).toBe(order.itemCount - 1);
    const events = (await ordersApi.getTimeline(SUBMITTED)).events;
    const edit = events.at(-1);
    expect(events.filter((e) => e.type === 'ITEMS_EDITED')).toHaveLength(1);
    expect(edit?.comment).toBe('Tovar qolmagan');
    expect(edit?.itemsChange?.lines.map((l) => l.change)).toEqual(['QUANTITY_CHANGED', 'REMOVED']);
    expect(edit?.itemsChange?.oldTotal).toBe('23570000.00');
    expect(edit?.notifications.map((n) => n.type)).toEqual(['ORDER_ITEMS_EDITED']);
    expect(edit?.itemsChange?.newTotal).not.toBeNull();

    // after approval the lines are locked
    const approved = await ordersApi.getOrder(APPROVED);
    const locked = await ordersApi
      .editItems(APPROVED, {
        changes: [{ itemId: fakeUuid('x'), quantity: '1' }],
        expectedRowVersion: approved.rowVersion,
      })
      .catch((e: unknown) => e);
    expect(reasonOf(locked)).toBe('ORDER_NOT_EDITABLE');
  });

  it('never lets an edit remove every line', async () => {
    const { ordersApi } = setup();
    const submitted = await ordersApi.getOrder(SUBMITTED);
    if (submitted.detail !== 'FULL') throw new Error('FULL expected');
    const error = await ordersApi
      .editItems(SUBMITTED, {
        changes: submitted.items.map((item) => ({ itemId: item.id, quantity: null })),
        expectedRowVersion: submitted.rowVersion,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiValidationError);
    expect((error as ApiValidationError).issues[0]?.path).toBe('changes');
  });
});

describe('payment method ([C] 2026-10-24)', () => {
  const methodOf = (order: StaffOrder) => (order.detail === 'FULL' ? order.paymentMethod : 'n/a');

  it('is required on approve (422 on paymentMethod), stored, and on the approval event', async () => {
    const { ordersApi } = setup();
    const before = await ordersApi.getOrder(SUBMITTED);
    expect(methodOf(before)).toBeNull();
    const missing = await ordersApi
      .approve(SUBMITTED, { expectedRowVersion: before.rowVersion } as never)
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ApiValidationError);
    expect((await ordersApi.getOrder(SUBMITTED)).status).toBe('SUBMITTED');
    const after = await ordersApi.approve(SUBMITTED, {
      ...(await fifoPlanOf(ordersApi, SUBMITTED)),
      paymentMethod: 'OFFICIAL',
      expectedRowVersion: before.rowVersion,
    });
    expect(methodOf(after)).toBe('OFFICIAL');
    const approval = (await ordersApi.getTimeline(SUBMITTED)).events.at(-1);
    expect(approval?.toStatus).toBe('MANAGER_APPROVED');
    expect(approval?.paymentMethodChange).toEqual({ from: null, to: 'OFFICIAL' });
  });

  it('lets only the manager change it, without a row version, as one PAYMENT_METHOD_CHANGED event', async () => {
    const { ordersApi, as } = setup();
    const before = await ordersApi.getOrder(APPROVED);
    expect(methodOf(before)).toBe('OFFICIAL');
    for (const who of ['admin', 'accountant', 'warehouse', 'driver'] as const) {
      const denied = await as(who, () =>
        ordersApi.setPaymentMethod(APPROVED, { paymentMethod: 'CASH' }),
      ).catch((e: unknown) => e);
      expect(denied, who).toBeInstanceOf(PermissionDeniedError);
    }
    const changed = await as('manager', () =>
      ordersApi.setPaymentMethod(APPROVED, { paymentMethod: 'CASH', comment: ' typo ' }),
    );
    expect(methodOf(changed)).toBe('CASH');
    expect(changed.rowVersion).toBe(before.rowVersion);
    expect(changed.status).toBe('MANAGER_APPROVED');
    const last = (await ordersApi.getTimeline(APPROVED)).events.at(-1);
    expect(last).toMatchObject({
      type: 'PAYMENT_METHOD_CHANGED',
      paymentMethodChange: { from: 'OFFICIAL', to: 'CASH' },
      comment: 'typo',
      notifications: [],
    });
    // the same value again is a no-op: no new event
    const count = (await ordersApi.getTimeline(APPROVED)).events.length;
    await ordersApi.setPaymentMethod(APPROVED, { paymentMethod: 'CASH' });
    expect((await ordersApi.getTimeline(APPROVED)).events).toHaveLength(count);
  });

  it('cannot be set before the approval nor after a reject or cancel (409 PAYMENT_METHOD_NOT_CHANGEABLE)', async () => {
    const { ordersApi } = setup();
    const early = await ordersApi
      .setPaymentMethod(SUBMITTED, { paymentMethod: 'CASH' })
      .catch((e: unknown) => e);
    expect(reasonOf(early)).toBe('PAYMENT_METHOD_NOT_CHANGEABLE');
    const approved = await ordersApi.getOrder(APPROVED);
    await ordersApi.cancel(APPROVED, {
      reason: "Mijoz so'rovi",
      expectedRowVersion: approved.rowVersion,
    });
    const late = await ordersApi
      .setPaymentMethod(APPROVED, { paymentMethod: 'CASH' })
      .catch((e: unknown) => e);
    expect(reasonOf(late)).toBe('PAYMENT_METHOD_NOT_CHANGEABLE');
    expect(methodOf(await ordersApi.getOrder(APPROVED))).toBe('OFFICIAL');
    // later stages can still change it
    const released = await ordersApi.setPaymentMethod(RELEASED, { paymentMethod: 'CASH' });
    expect(methodOf(released)).toBe('CASH');
  });

  it('is seen by manager and accountant only: absent for the admin, never in fulfilment views', async () => {
    const { ordersApi, as } = setup();
    for (const who of ['manager', 'accountant'] as const) {
      const order = await as(who, () => ordersApi.getOrder(APPROVED));
      expect(methodOf(order), who).toBe('OFFICIAL');
      const list = await as(who, () => ordersApi.listOrders({ limit: 100 }));
      expect(list.orders.find((o) => o.id === APPROVED)).toMatchObject({
        paymentMethod: 'OFFICIAL',
      });
      const timeline = await as(who, () => ordersApi.getTimeline(id('IO-10486')));
      expect(
        timeline.events.some((e) => e.type === 'PAYMENT_METHOD_CHANGED'),
        who,
      ).toBe(true);
    }
    const adminOrder = await as('admin', () => ordersApi.getOrder(APPROVED));
    expect('paymentMethod' in adminOrder).toBe(false);
    const adminList = await as('admin', () => ordersApi.listOrders({ limit: 100 }));
    expect(adminList.orders.some((o) => 'paymentMethod' in o)).toBe(false);
    for (const who of ['admin', 'warehouse', 'driver'] as const) {
      const order = await as(who, () => ordersApi.getOrder(RELEASED));
      expect('paymentMethod' in order, who).toBe(false);
      const timeline = await as(who, () => ordersApi.getTimeline(RELEASED));
      expect(
        timeline.events.every((e) => e.paymentMethodChange === null),
        who,
      ).toBe(true);
      expect(
        timeline.events.some((e) => e.type === 'PAYMENT_METHOD_CHANGED'),
        who,
      ).toBe(false);
    }
  });

  it('never reaches the customer timeline', async () => {
    const { customerTimeline } = setup();
    const events = customerTimeline(id('IO-10486')).events;
    expect(events.some((e) => (e.type as string) === 'PAYMENT_METHOD_CHANGED')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/paymentMethod|OFFICIAL|CASH/);
  });
});

describe('timelines per audience', () => {
  it('gives the staff the whole story: who, role, from and to, comments, notifications', async () => {
    const { ordersApi } = setup();
    const { events } = await ordersApi.getTimeline(DELIVERED);
    expect(events.map((e) => e.toStatus)).toEqual([
      'SUBMITTED',
      'MANAGER_APPROVED',
      'ACCOUNTING_CLEARED',
      'RELEASED',
      'DELIVERED',
    ]);
    expect(events[1]?.actor).toMatchObject({ role: 'MANAGER', name: 'Aziza Yusupova' });
    expect(events[2]?.accountingMode).toEqual({ from: 'PENDING', to: 'APPROVED' });
    expect(events[3]?.driver?.fullName).toBe('Bekzod Tursunov');
    expect(events[3]?.notifications.map((n) => [n.recipientKind, n.recipientName])).toEqual([
      ['USER', 'Bekzod Tursunov'],
      ['ORGANIZATION_CHAT', 'Mobile Center Samarqand'],
    ]);
    expect(events.every((e) => e.notifications.every((n) => n.status === 'SENT'))).toBe(true);
  });

  it('shows the warehouse and the driver roles only: no names, no accounting, no notifications', async () => {
    const { ordersApi, as } = setup();
    const { events, detail } = await as('warehouse', () => ordersApi.getTimeline(DELIVERED));
    expect(detail).toBe('FULFILMENT');
    expect(events.every((e) => e.actor.name === null && e.actor.userId === null)).toBe(true);
    expect(events.every((e) => e.accountingMode === null && e.notifications.length === 0)).toBe(
      true,
    );
  });

  it('shows the customer a different, smaller story than the staff', async () => {
    const { ordersApi, customerTimeline } = setup();
    const customer = customerTimeline(DELIVERED);
    expect(() => customerTimelineResponseSchema.parse(customer)).not.toThrow();
    const text = JSON.stringify(customer);
    for (const staffOnly of [
      'accountingMode',
      'driver',
      'notifications',
      'userId',
      'Aziza',
      'Nodira',
      'Bekzod',
    ]) {
      expect(text).not.toContain(staffOnly);
    }
    // the staff of the same order sees what the customer must not
    expect(JSON.stringify(await ordersApi.getTimeline(DELIVERED))).toContain('Aziza Yusupova');
    // roles of staff are visible, names of the customer's own colleagues are visible
    expect(customer.events[0]?.actor).toEqual({ role: 'SHOP_OWNER', name: 'Akmal Nurmatov' });
    expect(customer.events[1]?.actor).toEqual({ role: 'MANAGER', name: null });
    expect(customer.events.every((e) => e.customerNotified || e.type === 'SUBMITTED')).toBe(true);
  });
});

describe('dev scenarios', () => {
  it('fails, denies or empties reads on request, and never blocks writes', async () => {
    const make = (scenario: 'error' | 'denied' | 'empty') =>
      createFakeStaffOrders({
        clock: { now: () => new Date('2026-10-19T04:30:00.000Z') },
        actor: () => WHO.manager,
        scenario: () => scenario,
      }).ordersApi;
    await expect(make('error').listOrders()).rejects.toThrow();
    await expect(make('denied').listOrders()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await make('empty').listOrders()).orders).toEqual([]);
    await expect(make('empty').getOrder(SUBMITTED)).rejects.toBeInstanceOf(ApiNotFoundError);
    const api = make('error');
    const current = await createFakeStaffOrders({ actor: () => WHO.manager }).ordersApi.getOrder(
      SUBMITTED,
    );
    await expect(
      api.approve(SUBMITTED, {
        ...(await fifoPlanOf(api, SUBMITTED)),
        paymentMethod: 'CASH',
        expectedRowVersion: current.rowVersion,
      }),
    ).resolves.toBeDefined();
  });

  it('changes the payment plan like the server: manager only, SUBMITTED only, from the snapshots', async () => {
    const { as, ordersApi } = setup();
    const before = await as('manager', () => ordersApi.getOrder(id('IO-10490')));
    if (before.detail !== 'FULL') throw new Error('expected the FULL detail');
    const request = {
      paymentPlan: 'DEFERRED' as const,
      expectedRowVersion: before.rowVersion,
    };
    await expect(
      as('accountant', () => ordersApi.setPaymentPlan(before.id, request)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const after = await as('manager', () => ordersApi.setPaymentPlan(before.id, request));
    if (after.detail !== 'FULL') throw new Error('expected the FULL detail');
    expect(after.paymentPlan).toBe('DEFERRED');
    expect(after.rowVersion).toBe(before.rowVersion + 1);
    expect(after.items.map((item) => item.unitPrice)).toEqual(
      before.items.map((item) => item.deferredUnitPrice),
    );

    const moved = await as('manager', async () =>
      ordersApi.approve(after.id, {
        ...(await fifoPlanOf(ordersApi, after.id)),
        paymentMethod: 'CASH',
        expectedRowVersion: after.rowVersion,
      }),
    );
    const late = await as('manager', () =>
      ordersApi
        .setPaymentPlan(after.id, { paymentPlan: 'FULL', expectedRowVersion: moved.rowVersion })
        .catch((error: unknown) => error),
    );
    expect(late).toBeInstanceOf(ApiConflictError);
    expect((late as ApiConflictError).reason).toBe('PAYMENT_PLAN_NOT_CHANGEABLE');
  });
});
