import { Prisma } from '../src/generated/prisma/client.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { InputValidationError, NotFoundError } from '../src/common/errors/domain-errors.js';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import {
  findForbiddenKeys,
  findStaffOnlyFields,
  stripStaffOrderUsd,
} from './support/forbidden-fields.js';
import {
  createWorld,
  orderAt,
  submitOrder,
  toPlainJson,
  type World,
} from './support/orders-world.js';
import { WORLD_USD_RATE } from './support/orders-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('reading orders: isolation, scopes and no cost data (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;
  /** Every order of the scenario by a readable name (A = organization A, B = organization B). */
  let o: Record<
    | 'aSubmitted'
    | 'aApproved'
    | 'aCleared'
    | 'aReleased'
    | 'aDelivered'
    | 'aReceived'
    | 'aRejected'
    | 'aCancelledEarly'
    | 'aCancelledAfterClearance'
    | 'bSubmitted'
    | 'bSkipped',
    OrderView
  >;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    w = await createWorld(t);
    o = {
      aSubmitted: await orderAt(w, 'SUBMITTED'),
      aApproved: await orderAt(w, 'MANAGER_APPROVED'),
      aCleared: await orderAt(w, 'ACCOUNTING_CLEARED'),
      aReleased: await orderAt(w, 'RELEASED'),
      aDelivered: await orderAt(w, 'DELIVERED'),
      aReceived: await orderAt(w, 'RECEIVED'),
      aRejected: await orderAt(w, 'REJECTED'),
      aCancelledEarly: await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' }),
      aCancelledAfterClearance: await orderAt(w, 'CANCELLED', {
        cancelAfter: 'ACCOUNTING_CLEARED',
      }),
      bSubmitted: await submitOrder(w, w.actors.sellerB),
      bSkipped: await submitOrder(w, w.actors.ownerB),
    };
    await w.step(w.actors.manager, o.bSkipped.id, {
      to: 'MANAGER_APPROVED',
      skipAccounting: true,
    });
  });

  const idsOf = async (actor: Actor): Promise<string[]> => {
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await w.orders.listOrdersFor(actor, { limit: 4, ...(cursor ? { cursor } : {}) });
      all.push(...page.orders.map((order) => order.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  };
  const names = (ids: string[]): string[] =>
    Object.entries(o)
      .filter(([, order]) => ids.includes(order.id))
      .map(([name]) => name)
      .sort();
  const allNames = [
    'aApproved',
    'aCancelledAfterClearance',
    'aCancelledEarly',
    'aCleared',
    'aDelivered',
    'aReceived',
    'aRejected',
    'aReleased',
    'aSubmitted',
    'bSkipped',
    'bSubmitted',
  ];
  const orgANames = allNames.filter((n) => n.startsWith('a'));

  describe('organization isolation (hard rule 6)', () => {
    it('a customer lists only the orders of their own organization', async () => {
      for (const actor of [w.actors.sellerA, w.actors.sellerA2, w.actors.ownerA]) {
        expect(names(await idsOf(actor)), actor.userId).toEqual(orgANames);
      }
      for (const actor of [w.actors.sellerB, w.actors.ownerB]) {
        expect(names(await idsOf(actor)), actor.userId).toEqual(['bSkipped', 'bSubmitted']);
      }
    });

    it('a customer sees colleagues orders in every status, including rejected and cancelled', async () => {
      const seen = names(await idsOf(w.actors.sellerA2));
      expect(seen).toContain('aRejected');
      expect(seen).toContain('aCancelledEarly');
      expect(seen).toContain('aSubmitted');
    });

    it('another organization gets NOT FOUND (not forbidden) for every order, in every status', async () => {
      for (const [name, order] of Object.entries(o).filter(([n]) => n.startsWith('a'))) {
        for (const actor of [w.actors.sellerB, w.actors.ownerB]) {
          await expect(w.orders.getOrderFor(actor, order.id), name).rejects.toBeInstanceOf(
            NotFoundError,
          );
        }
      }
      for (const order of [o.bSubmitted, o.bSkipped]) {
        await expect(w.orders.getOrderFor(w.actors.sellerA, order.id)).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
    });

    it('a filter on another organization cannot widen the scope', async () => {
      const page = await w.orders.listOrdersFor(w.actors.sellerA, { organizationId: w.orgB });
      expect(page.orders).toEqual([]);
      const own = await w.orders.listOrdersFor(w.actors.sellerA, { organizationId: w.orgA });
      expect(own.orders.length).toBeGreaterThan(0);
    });

    it('a person who is not a member of any organization sees nothing', async () => {
      const stranger: Actor = { userId: w.ids.sellerA, staffRoles: [] };
      expect((await w.orders.listOrdersFor(stranger)).orders).toEqual([]);
      await expect(w.orders.getOrderFor(stranger, o.aSubmitted.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('staff membership is ignored: a staff person never reads as a customer', async () => {
      const staffWithMembership: Actor = {
        userId: w.ids.driver,
        staffRoles: ['DRIVER'],
        membership: { organizationId: w.orgA, role: 'SHOP_OWNER' },
      };
      // a driver sees assigned orders only, whatever membership was passed in
      expect(names(await idsOf(staffWithMembership))).toEqual(
        ['aDelivered', 'aReceived', 'aReleased'].sort(),
      );
    });
  });

  describe('staff scopes', () => {
    it('manager, accountant and admin see every order', async () => {
      for (const actor of [w.actors.manager, w.actors.accountant, w.actors.admin]) {
        expect(names(await idsOf(actor)), actor.userId).toEqual(allNames);
      }
    });

    it('the warehouse sees orders from MANAGER_APPROVED on, and cancelled ones that had been approved', async () => {
      expect(names(await idsOf(w.actors.warehouse))).toEqual(
        [
          'aApproved',
          'aCleared',
          'aReleased',
          'aDelivered',
          'aReceived',
          'aCancelledAfterClearance',
          'aCancelledEarly',
          // accounting skipped by the manager counts as cleared
          'bSkipped',
        ].sort(),
      );
    });

    it('the warehouse gets NOT FOUND for submitted orders and for those closed before approval', async () => {
      for (const order of [o.aSubmitted, o.aRejected, o.bSubmitted]) {
        await expect(w.orders.getOrderFor(w.actors.warehouse, order.id)).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      for (const order of [
        o.aApproved,
        o.aCleared,
        o.aCancelledAfterClearance,
        o.aCancelledEarly,
        o.bSkipped,
        o.aReceived,
      ]) {
        await expect(w.orders.getOrderFor(w.actors.warehouse, order.id)).resolves.toBeDefined();
      }
    });

    it('a driver sees only the orders assigned to them', async () => {
      expect(names(await idsOf(w.actors.driver))).toEqual(
        ['aDelivered', 'aReceived', 'aReleased'].sort(),
      );
      expect(await idsOf(w.actors.driver2)).toEqual([]);
      await expect(w.orders.getOrderFor(w.actors.driver2, o.aReleased.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(w.orders.getOrderFor(w.actors.driver, o.aCleared.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('customers see no staff details; staff do', async () => {
      const asCustomer = await w.orders.getOrderFor(w.actors.sellerA, o.aReleased.id);
      expect(asCustomer.staff).toBeNull();
      const asDriver = await w.orders.getOrderFor(w.actors.driver, o.aReleased.id);
      // The driver and the warehouse get what their step needs, no accounting or pricing facts.
      const fulfilment = {
        detail: 'FULFILMENT',
        driverUserId: w.ids.driver,
        goodsReturn: 'NOT_NEEDED',
        goodsReturnedAt: null,
      };
      expect(asDriver.staff).toEqual(fulfilment);
      const asWarehouse = await w.orders.getOrderFor(w.actors.warehouse, o.aReleased.id);
      expect(asWarehouse.staff).toEqual(fulfilment);
      for (const actor of [w.actors.manager, w.actors.accountant, w.actors.admin]) {
        const full = await w.orders.getOrderFor(actor, o.bSkipped.id);
        expect(full.staff).toMatchObject({
          detail: 'FULL',
          accountingMode: 'SKIPPED_BY_MANAGER',
          priceListVersionId: w.versionId,
        });
      }
      const summary = (await w.orders.listOrdersFor(w.actors.warehouse)).orders.map((s) => s.staff);
      expect(summary.length).toBeGreaterThan(0);
      for (const staff of summary) {
        expect(Object.keys(staff ?? {}).sort()).toEqual([
          'detail',
          'driverUserId',
          'goodsReturn',
          'goodsReturnedAt',
        ]);
      }
    });
  });

  describe('filters and pages', () => {
    it('filters by status and payment status inside the actor scope', async () => {
      const cancelled = await w.orders.listOrdersFor(w.actors.sellerA, { status: 'CANCELLED' });
      expect(names(cancelled.orders.map((x) => x.id))).toEqual(
        ['aCancelledAfterClearance', 'aCancelledEarly'].sort(),
      );
      // [C] 2026-10-26: PAID follows from the organization's payments.
      await w.payments.recordPayment(w.actors.manager, w.orgA, {
        amount: o.aReceived.totalAmount.toFixed(2),
        currency: 'UZS',
        rate: WORLD_USD_RATE,
        paidOn: '2026-10-20',
      });
      const paid = await w.orders.listOrdersFor(w.actors.manager, { paymentStatus: 'PAID' });
      expect(paid.orders.map((x) => x.id)).toEqual([o.aReceived.id]);
      // a warehouse filter for a status it may not see is empty, not an error
      const hidden = await w.orders.listOrdersFor(w.actors.warehouse, { status: 'SUBMITTED' });
      expect(hidden.orders).toEqual([]);
    });

    it('lets staff narrow by organization', async () => {
      const page = await w.orders.listOrdersFor(w.actors.manager, { organizationId: w.orgB });
      expect(names(page.orders.map((x) => x.id))).toEqual(['bSkipped', 'bSubmitted']);
    });

    it('pages newest first without gaps or repeats', async () => {
      const first = await w.orders.listOrdersFor(w.actors.manager, { limit: 5 });
      expect(first.orders).toHaveLength(5);
      expect(first.nextCursor).toBe(first.orders[4]?.id);
      const everything = await idsOf(w.actors.manager);
      expect(new Set(everything).size).toBe(everything.length);
      expect(everything).toHaveLength(11);
      expect(everything[0]).toBe(o.bSkipped.id); // the newest
      expect(
        (await w.orders.listOrdersFor(w.actors.manager, { limit: 100 })).nextCursor,
      ).toBeNull();
    });

    it('rejects bad filters', async () => {
      for (const filters of [
        { limit: 0 },
        { limit: 101 },
        { status: 'NOPE' },
        { cursor: 'x' },
        { organizationId: 'x' },
      ]) {
        await expect(
          w.orders.listOrdersFor(w.actors.manager, filters as never),
        ).rejects.toBeInstanceOf(InputValidationError);
      }
    });

    it('answers a list item without lines but with their count', async () => {
      const page = await w.orders.listOrdersFor(w.actors.sellerA, { status: 'SUBMITTED' });
      expect(page.orders[0]).toMatchObject({ itemCount: 2, orderNumber: o.aSubmitted.orderNumber });
      expect(page.orders[0]).not.toHaveProperty('items');
    });
  });

  describe('a customer never sees cost data (hard rule 7)', () => {
    const SECRET_SUPPLIER = 'SECRET-SUPPLIER-XYZ';
    const SECRET_NUMBERS = ['8765.4321', '12987.6543', '113900000.00', '8765.43'];

    beforeEach(async () => {
      // Real cost data for the very products that are ordered, in the staff-only table.
      for (const productId of [w.products.p1, w.products.p2]) {
        await w.prisma.priceReference.create({
          data: {
            productId,
            deliveryRef: `D-${productId.slice(0, 8)}`,
            supplier: SECRET_SUPPLIER,
            purchaseMethod: 'SECRET-METHOD',
            category: 'SECRET-CATEGORY',
            deliveredQuantity: new Prisma.Decimal('100'),
            availableQuantity: new Prisma.Decimal('55'),
            costUsd: new Prisma.Decimal('8765.4321'),
            usdRateUsed: new Prisma.Decimal('12987.6543'),
            costUzs: new Prisma.Decimal('113900000.00'),
            deliveredAt: new Date('2026-10-01T00:00:00Z'),
            syncedAt: new Date('2026-10-02T00:00:00Z'),
          },
        });
      }
    });

    it('everything returned to customers is free of cost and staff-only fields and values', async () => {
      const customer = w.actors.sellerA;
      const fresh = await submitOrder(w, customer);
      const edited = await w.edit(w.actors.manager, fresh.id, {
        changes: [{ itemId: fresh.items[0]?.id ?? '', quantity: '3' }],
      });
      const returned: unknown[] = [
        await w.carts.getCart(customer),
        fresh,
        // what a customer receives for the manager's edit is the order read afterwards
        await w.orders.getOrderFor(customer, edited.id),
        await w.orders.listOrdersFor(customer),
        await w.orders.listOrdersFor(w.actors.ownerA, { status: 'DELIVERED' }),
        ...(await Promise.all(
          Object.values(o)
            .filter((x) => x.organizationId === w.orgA)
            .map((x) => w.orders.getOrderFor(customer, x.id)),
        )),
      ];
      // only the manager cancels; what the customer receives is the order read afterwards
      await w.step(w.actors.manager, fresh.id, { to: 'CANCELLED', reason: 'changed my mind' });
      returned.push(await w.orders.getOrderFor(customer, fresh.id));
      const json = toPlainJson(returned);
      expect(findForbiddenKeys(json)).toEqual([]);
      expect(findStaffOnlyFields(json)).toEqual([]);
      const text = JSON.stringify(json);
      for (const secret of [
        SECRET_SUPPLIER,
        'SECRET-METHOD',
        'SECRET-CATEGORY',
        ...SECRET_NUMBERS,
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it('the warehouse and the driver see no cost data either', async () => {
      const returned = toPlainJson([
        await w.orders.listOrdersFor(w.actors.warehouse),
        await w.orders.getOrderFor(w.actors.warehouse, o.aCleared.id),
        await w.orders.listOrdersFor(w.actors.driver),
        await w.orders.getOrderFor(w.actors.driver, o.aReleased.id),
      ]);
      expect(findForbiddenKeys(returned)).toEqual([]);
      expect(JSON.stringify(returned)).not.toContain(SECRET_SUPPLIER);
    });

    it('no event payload and no outbox payload carries cost data, in any step', async () => {
      const events = await t.prisma.orderEvent.findMany();
      const messages = await t.prisma.notificationOutbox.findMany();
      expect(events.length).toBeGreaterThan(10);
      expect(messages.length).toBeGreaterThan(10);
      // The events are staff history and keep the order's USD facts (hard rule 12); the timeline maps
      // them field by field, so customers never get them. A message carries none at all.
      const payloads = toPlainJson([
        ...events.map((e) => stripStaffOrderUsd(e.payload)),
        ...messages.map((m) => m.payload),
      ]);
      expect(findForbiddenKeys(payloads)).toEqual([]);
      // The accountant's approval message is the one row the owner gave supplies and parties
      // ([C] 2026-10-30). It stays under the cost scan above and the secret check below.
      const withoutThatRow = toPlainJson([
        ...events.map((e) => e.payload),
        ...messages
          .filter((m) => !(m.type === 'ORDER_MANAGER_APPROVED' && m.recipientRole === 'ACCOUNTANT'))
          .map((m) => m.payload),
      ]);
      expect(findStaffOnlyFields(withoutThatRow)).toEqual([]);
      const text = JSON.stringify(payloads);
      for (const secret of [SECRET_SUPPLIER, ...SECRET_NUMBERS]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it('the order tables have no cost columns', async () => {
      const columns = await t.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('orders', 'order_items', 'order_events', 'notification_outbox', 'carts', 'cart_items')`;
      const names = columns.map((c) => c.column_name);
      const usdColumns = [
        'usd_rate',
        'total_usd',
        'full_unit_price_usd',
        'deferred_unit_price_usd',
      ];
      expect(names).toEqual(expect.arrayContaining(usdColumns));
      expect(
        findForbiddenKeys(
          Object.fromEntries(names.filter((n) => !usdColumns.includes(n)).map((n) => [n, 1])),
        ),
      ).toEqual([]);
    });
  });
});
