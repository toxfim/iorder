import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import { CUSTOMER_PAYLOAD_KEYS } from '../src/modules/orders/order-notifications.js';
import { OrdersRepository } from '../src/modules/orders/orders.repository.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

// The owner's rule of 2026-11-09 (lifecycle 6.3) against a real PostgreSQL: the customer side
// (the organization's group and the person who placed the order) gets an outbox row ONLY when the
// manager approves, when the order is rejected or cancelled, and when the manager changes its
// lines or its payment plan. Every other step writes its event and its staff rows, and nothing
// for the customer side.

describe('customer-side order notifications (real PostgreSQL)', () => {
  let t: TestApp;
  let w: World;

  beforeAll(async () => {
    t = await createTestApp([OrdersModule]);
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    w = await createWorld(t);
    // Both prices, so a payment plan can change: 2 x p1 + 1 x p2 = 3750.50 or 4500.25.
    await publishPriceList(
      w.pricing,
      { [w.products.p1]: '1500.00', [w.products.p2]: '750.50' },
      w.prisma,
      'UZS',
      { [w.products.p1]: '1800.00', [w.products.p2]: '900.25' },
    );
  });

  const customers = (): string[] => [
    w.ids.ownerA,
    w.ids.sellerA,
    w.ids.sellerA2,
    w.ids.ownerB,
    w.ids.sellerB,
  ];

  /** Every outbox row of the order, oldest first. */
  const rowsOf = (orderId: string) =>
    w.prisma.notificationOutbox.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  /** The rows addressed to the customer side: an organization group or a customer in private. */
  async function customerRows(orderId: string) {
    return (await rowsOf(orderId)).filter(
      (row) =>
        row.recipientKind === 'ORGANIZATION_CHAT' ||
        (row.recipientKind === 'USER' && customers().includes(row.recipientUserId ?? '')),
    );
  }

  /** "TYPE>GROUP" for the organization A group, "TYPE>PLACER" for the seller who ordered. */
  async function customerSide(orderId: string): Promise<string[]> {
    return (await customerRows(orderId))
      .map((row) => {
        if (row.recipientOrganizationId === w.orgA) return `${row.type}>GROUP`;
        return row.recipientUserId === w.ids.sellerA ? `${row.type}>PLACER` : `${row.type}>OTHER`;
      })
      .sort();
  }

  /** "TYPE>who" for every row that is NOT for the customer side. */
  async function staffSide(orderId: string): Promise<string[]> {
    const customer = new Set((await customerRows(orderId)).map((row) => row.id));
    const names = new Map(Object.entries(w.ids).map(([name, id]) => [id, name]));
    return (await rowsOf(orderId))
      .filter((row) => !customer.has(row.id))
      .map((row) => `${row.type}>${row.recipientRole ?? names.get(row.recipientUserId ?? '')}`)
      .sort();
  }

  const line = (order: OrderView, code: string): string => {
    const found = order.items.find((item) => item.productCode === code);
    if (!found) throw new Error(`no line ${code}`);
    return found.id;
  };

  describe('a whole order life', () => {
    it('submit, approve, accounting, release, deliver, receive: the customer side hears about the approval and nothing else', async () => {
      const order = await submitOrder(w);
      expect(await customerSide(order.id)).toEqual([]);

      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      expect(await customerSide(order.id)).toEqual(['ORDER_MANAGER_APPROVED>GROUP']);

      await w.step(w.actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' });
      await w.step(w.actors.warehouse, order.id, { to: 'RELEASED', driverUserId: w.ids.driver });
      await w.step(w.actors.driver, order.id, { to: 'DELIVERED' });
      const received = await w.step(w.actors.ownerA, order.id, { to: 'RECEIVED' });
      expect(received.status).toBe('RECEIVED');

      expect(await customerSide(order.id)).toEqual(['ORDER_MANAGER_APPROVED>GROUP']);

      // Every step still wrote its event, and staff still get every message of their role.
      const events = await w.prisma.orderEvent.findMany({
        where: { orderId: order.id },
        orderBy: { seq: 'asc' },
      });
      expect(events.map((event) => event.toStatus)).toEqual([
        'SUBMITTED',
        'MANAGER_APPROVED',
        'ACCOUNTING_CLEARED',
        'RELEASED',
        'DELIVERED',
        'RECEIVED',
      ]);
      expect(await staffSide(order.id)).toEqual(
        [
          'ORDER_SUBMITTED>MANAGER',
          'ORDER_MANAGER_APPROVED>ACCOUNTANT',
          'ORDER_READY_TO_PREPARE>WAREHOUSE_MANAGER',
          'ORDER_ACCOUNTING_CLEARED>WAREHOUSE_MANAGER',
          'ORDER_RELEASED>driver',
          'ORDER_RECEIVED>MANAGER',
        ].sort(),
      );

      // The one customer row belongs to the approval's event and carries only allow-listed facts.
      const [row] = await customerRows(order.id);
      expect(row?.orderEventId).toBe(events[1]?.id);
      expect(row?.status).toBe('PENDING');
      expect(
        Object.keys(row?.payload as object).filter((key) => !CUSTOMER_PAYLOAD_KEYS.includes(key)),
      ).toEqual([]);
      expect(row?.payload).toMatchObject({
        orderNumber: order.orderNumber,
        status: 'MANAGER_APPROVED',
      });
    });

    it('an approval that skips accounting is one message for the customer side, not two', async () => {
      const order = await submitOrder(w);
      const cleared = await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
        skipAccounting: true,
      });
      expect(cleared.status).toBe('ACCOUNTING_CLEARED');
      expect(await customerSide(order.id)).toEqual(['ORDER_MANAGER_APPROVED>GROUP']);
      expect(await staffSide(order.id)).toEqual(
        [
          'ORDER_SUBMITTED>MANAGER',
          'ORDER_MANAGER_APPROVED>ACCOUNTANT',
          'ORDER_ACCOUNTING_CLEARED>WAREHOUSE_MANAGER',
        ].sort(),
      );
    });

    it('the approval and its customer row are one transaction: a failed outbox write leaves neither', async () => {
      const order = await submitOrder(w);
      vi.spyOn(t.get(OrdersRepository), 'insertOutbox').mockRejectedValueOnce(
        new Error('outbox down'),
      );
      await expect(w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' })).rejects.toThrow(
        'outbox down',
      );
      const stored = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored.status).toBe('SUBMITTED');
      expect(await customerSide(order.id)).toEqual([]);
      expect(
        await w.prisma.orderEvent.count({
          where: { orderId: order.id, toStatus: 'MANAGER_APPROVED' },
        }),
      ).toBe(0);
    });
  });

  describe('the manager changes what the order costs', () => {
    it('an edit of the lines writes exactly one customer row, with the old and the new total', async () => {
      const order = await submitOrder(w);
      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-1'), quantity: '1' }],
        reason: 'only 1 left',
      });
      expect(await customerSide(order.id)).toEqual(['ORDER_ITEMS_EDITED>GROUP']);
      const [row] = await customerRows(order.id);
      expect(row?.payload).toMatchObject({
        oldTotalAmount: '3750.50',
        newTotalAmount: '2250.50',
      });
      const event = await w.prisma.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, eventType: 'ITEMS_EDITED' },
      });
      expect(row?.orderEventId).toBe(event.id);
    });

    it('each further edit writes one more', async () => {
      const order = await submitOrder(w);
      const once = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-1'), quantity: '1' }],
      });
      await w.edit(w.actors.manager, once.id, {
        changes: [{ itemId: line(once, 'P-1'), quantity: '3' }],
      });
      expect(await customerSide(order.id)).toEqual([
        'ORDER_ITEMS_EDITED>GROUP',
        'ORDER_ITEMS_EDITED>GROUP',
      ]);
    });

    it('a payment plan change by the manager writes exactly one customer row, with both plans and totals', async () => {
      const order = await submitOrder(w);
      await w.orders.setPaymentPlan(w.actors.manager, order.id, {
        paymentPlan: 'DEFERRED',
        expectedRowVersion: order.rowVersion,
      });
      expect(await customerSide(order.id)).toEqual(['ORDER_PAYMENT_PLAN_CHANGED>GROUP']);
      const [row] = await customerRows(order.id);
      expect(row?.payload).toMatchObject({
        oldPaymentPlan: 'FULL',
        newPaymentPlan: 'DEFERRED',
        oldTotalAmount: '3750.50',
        newTotalAmount: '4500.25',
      });
    });

    it("the customer's own plan change tells the managers and nobody on the customer side", async () => {
      const order = await submitOrder(w);
      await w.orders.changeOwnPaymentPlan(w.actors.sellerA, order.id, {
        paymentPlan: 'DEFERRED',
        expectedRowVersion: order.rowVersion,
      });
      expect(await customerSide(order.id)).toEqual([]);
      expect(await staffSide(order.id)).toEqual(
        ['ORDER_SUBMITTED>MANAGER', 'ORDER_PAYMENT_PLAN_CHANGED>MANAGER'].sort(),
      );
    });
  });

  describe('a refusal', () => {
    // Written by a person: spaces inside, quotes and characters that would be markup elsewhere.
    const REASON = 'Tovar yo‘q: <omborda> tugagan & "keyingi hafta"';

    it('the manager rejects a submitted order: one customer row with the reason as written', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'REJECTED', reason: `  ${REASON}  ` });
      expect(await customerSide(order.id)).toEqual(['ORDER_REJECTED>GROUP']);
      const [row] = await customerRows(order.id);
      expect((row?.payload as { reason?: string }).reason).toBe(REASON);
    });

    it('the accountant rejects an approved order: one more customer row, with the reason', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      await w.step(w.actors.accountant, order.id, { to: 'REJECTED', reason: REASON });
      expect(await customerSide(order.id)).toEqual([
        'ORDER_MANAGER_APPROVED>GROUP',
        'ORDER_REJECTED>GROUP',
      ]);
      const rejection = (await customerRows(order.id)).find((r) => r.type === 'ORDER_REJECTED');
      expect((rejection?.payload as { reason?: string }).reason).toBe(REASON);
      expect(Object.keys(rejection?.payload as object)).not.toContain('actorRole');
    });

    it.each([
      ['SUBMITTED', []],
      ['MANAGER_APPROVED', ['ORDER_MANAGER_APPROVED>GROUP']],
      ['ACCOUNTING_CLEARED', ['ORDER_MANAGER_APPROVED>GROUP']],
    ] as const)(
      'the manager cancels a %s order: the group and the placer, both with the reason as written',
      async (status, before) => {
        const order = await orderAt(w, status);
        expect(await customerSide(order.id)).toEqual([...before]);
        await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: REASON });
        expect(await customerSide(order.id)).toEqual(
          [...before, 'ORDER_CANCELLED>GROUP', 'ORDER_CANCELLED>PLACER'].sort(),
        );
        const cancellations = (await customerRows(order.id)).filter(
          (row) => row.type === 'ORDER_CANCELLED',
        );
        expect(cancellations).toHaveLength(2);
        for (const row of cancellations) {
          expect((row.payload as { reason?: string }).reason).toBe(REASON);
          expect(
            Object.keys(row.payload as object).filter(
              (key) => !CUSTOMER_PAYLOAD_KEYS.includes(key),
            ),
          ).toEqual([]);
        }
      },
    );
  });

  it('never writes a customer row for another organization', async () => {
    const order = await orderAt(w, 'CANCELLED', { cancelAfter: 'MANAGER_APPROVED' });
    const rows = await customerRows(order.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.recipientOrganizationId ?? w.orgA).toBe(w.orgA);
      expect([null, w.ids.sellerA]).toContain(row.recipientUserId);
    }
  });
});
