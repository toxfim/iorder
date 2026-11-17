import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../src/common/errors/domain-errors.js';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import { OrdersRepository } from '../src/modules/orders/orders.repository.js';
import { publishPriceList } from './support/orders-fixtures.js';
import { createWorld, orderAt, submitOrder, type World } from './support/orders-world.js';
import { createTestApp, type TestApp } from './support/test-app.js';

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected the call to fail');
}

describe('manager edits and payment status (real PostgreSQL)', () => {
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
  });

  const events = (orderId: string) =>
    w.prisma.orderEvent.findMany({ where: { orderId }, orderBy: { seq: 'asc' } });
  const line = (order: OrderView, code: string) => {
    const found = order.items.find((i) => i.productCode === code);
    if (!found) throw new Error(`no line ${code}`);
    return found;
  };

  describe('manager edits (lifecycle 3.2)', () => {
    it('changes a quantity: new totals, one event with before/after, one message, row_version + 1', async () => {
      const order = await submitOrder(w); // 2 x 1500.00 + 1 x 750.50 = 3750.50
      t.clock.set(new Date('2026-10-20T09:30:00Z'));
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-1').id, quantity: '1' }],
        reason: 'only 1 left',
      });

      // 1 x 1500.00 = 1500.00 ; total 1500.00 + 750.50 = 2250.50
      expect(
        edited.items.map((i) => [
          i.productCode,
          i.quantity.toFixed(3),
          i.unitPrice.toFixed(2),
          i.lineTotal.toFixed(2),
        ]),
      ).toEqual([
        ['P-1', '1.000', '1500.00', '1500.00'],
        ['P-2', '1.000', '750.50', '750.50'],
      ]);
      expect(edited.totalAmount.toFixed(2)).toBe('2250.50');
      expect(edited.rowVersion).toBe(2);
      expect(edited.status).toBe('SUBMITTED');

      const log = await events(order.id);
      expect(log).toHaveLength(2);
      expect(log[1]).toMatchObject({
        eventType: 'ITEMS_EDITED',
        fromStatus: null,
        toStatus: null,
        actorUserId: w.ids.manager,
        actorRole: 'MANAGER',
        comment: 'only 1 left',
      });
      expect(log[1]?.payload).toEqual({
        before: {
          totalAmount: '3750.50',
          totalUsd: '0.312542',
          lines: [
            {
              productCode: 'P-1',
              name: 'Olma',
              quantity: '2.000',
              unitPrice: '1500.00',
              lineTotal: '3000.00',
            },
            {
              productCode: 'P-2',
              name: 'Nok',
              quantity: '1.000',
              unitPrice: '750.50',
              lineTotal: '750.50',
            },
          ],
        },
        after: {
          totalAmount: '2250.50',
          totalUsd: '0.187542',
          lines: [
            {
              productCode: 'P-1',
              name: 'Olma',
              quantity: '1.000',
              unitPrice: '1500.00',
              lineTotal: '1500.00',
            },
            {
              productCode: 'P-2',
              name: 'Nok',
              quantity: '1.000',
              unitPrice: '750.50',
              lineTotal: '750.50',
            },
          ],
        },
      });

      const messages = await w.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, type: 'ORDER_ITEMS_EDITED' },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        recipientKind: 'ORGANIZATION_CHAT',
        recipientOrganizationId: w.orgA,
        status: 'PENDING',
      });
      expect(messages[0]?.payload).toMatchObject({
        oldTotalAmount: '3750.50',
        newTotalAmount: '2250.50',
        orderNumber: order.orderNumber,
        reason: 'only 1 left',
      });
    });

    it('removes a line', async () => {
      const order = await submitOrder(w);
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-2').id, quantity: null }],
      });
      expect(edited.items.map((i) => i.productCode)).toEqual(['P-1']);
      expect(edited.totalAmount.toFixed(2)).toBe('3000.00');
      expect(await w.prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1);
      const messages = await w.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, type: 'ORDER_ITEMS_EDITED' },
      });
      expect(messages[0]?.payload).toMatchObject({
        oldTotalAmount: '3750.50',
        newTotalAmount: '3000.00',
      });
    });

    it('recalculates with the SAME snapshot prices, never with a newer price list', async () => {
      const order = await submitOrder(w);
      await publishPriceList(
        w.pricing,
        { [w.products.p1]: '9000.00', [w.products.p2]: '9.00' },
        w.prisma,
      );
      const edited = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-2').id, quantity: '3' }],
      });
      // 3 x 750.50 (the order's own price) = 2251.50 ; total 3000.00 + 2251.50
      expect(line(edited, 'P-2').unitPrice.toFixed(2)).toBe('750.50');
      expect(edited.totalAmount.toFixed(2)).toBe('5251.50');
      expect(
        (await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).priceListVersionId,
      ).toBe(w.versionId);
    });

    it('can be repeated: each save is one event and one message, and the total stays the sum of the lines', async () => {
      const order = await submitOrder(w);
      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-1').id, quantity: '1' }],
      });
      const second = await w.edit(w.actors.manager2, order.id, {
        changes: [{ itemId: line(order, 'P-1').id, quantity: '4' }],
      });
      expect(second.rowVersion).toBe(3);
      expect(second.totalAmount.toFixed(2)).toBe('6750.50');
      expect((await events(order.id)).map((e) => e.eventType)).toEqual([
        'SUBMITTED',
        'ITEMS_EDITED',
        'ITEMS_EDITED',
      ]);
      const messages = await w.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, type: 'ORDER_ITEMS_EDITED' },
      });
      expect(messages).toHaveLength(2);
      expect(new Set(messages.map((m) => m.dedupeKey)).size).toBe(2);
    });

    it('changes nothing, and writes nothing, when nothing really changes', async () => {
      const order = await submitOrder(w);
      const same = await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: line(order, 'P-1').id, quantity: '2' }],
      });
      expect(same.rowVersion).toBe(1);
      expect(await events(order.id)).toHaveLength(1);
      expect(
        await w.prisma.notificationOutbox.count({ where: { type: 'ORDER_ITEMS_EDITED' } }),
      ).toBe(0);
    });

    it('is possible only while SUBMITTED', async () => {
      for (const status of [
        'MANAGER_APPROVED',
        'ACCOUNTING_CLEARED',
        'RELEASED',
        'CANCELLED',
      ] as const) {
        const order = await orderAt(w, status);
        const error = await failure(
          w.edit(w.actors.manager, order.id, {
            changes: [{ itemId: line(order, 'P-1').id, quantity: '1' }],
          }),
        );
        expect(error, status).toBeInstanceOf(ConflictError);
        expect((error as ConflictError).reason).toBe('ORDER_NOT_EDITABLE');
      }
    });

    it('freezes the lines at the database too once the order is approved', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      const id = line(order, 'P-1').id;
      // Prisma's own update/delete would hide the database message behind a generic error.
      await expect(
        w.prisma
          .$executeRaw`UPDATE order_items SET quantity = 1, line_total = 1500.00 WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/immutable once the order left SUBMITTED/);
      await expect(
        w.prisma.$executeRaw`DELETE FROM order_items WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/immutable once the order left SUBMITTED/);
      await expect(w.prisma.orderItem.delete({ where: { id } })).rejects.toThrow();
    });

    it('is for the manager only', async () => {
      const order = await submitOrder(w);
      const changes = [{ itemId: line(order, 'P-1').id, quantity: '1' }];
      for (const actor of [
        w.actors.sellerA,
        w.actors.ownerA,
        w.actors.admin,
        w.actors.accountant,
      ]) {
        expect(await failure(w.edit(actor, order.id, { changes }))).toBeInstanceOf(ForbiddenError);
      }
      for (const actor of [w.actors.sellerB, w.actors.warehouse, w.actors.driver]) {
        expect(await failure(w.edit(actor, order.id, { changes }))).toBeInstanceOf(NotFoundError);
      }
      expect((await w.orders.getOrderFor(w.actors.manager, order.id)).rowVersion).toBe(1);
    });

    it('rejects bad input without changing anything', async () => {
      const order = await submitOrder(w);
      const other = await submitOrder(w);
      const p1 = line(order, 'P-1').id;
      const p2 = line(order, 'P-2').id;
      const bad: unknown[] = [
        { changes: [] },
        { changes: [{ itemId: p1, quantity: '0' }] },
        { changes: [{ itemId: p1, quantity: '-1' }] },
        { changes: [{ itemId: p1, quantity: '1.2345' }] },
        { changes: [{ itemId: p1, quantity: 2 }] },
        { changes: [{ itemId: 'nope', quantity: '1' }] },
        {
          changes: [
            { itemId: p1, quantity: '1' },
            { itemId: p1, quantity: '2' },
          ],
        },
        { changes: [{ itemId: p1, quantity: '1', price: '1.00' }] },
        // every line removed
        {
          changes: [
            { itemId: p1, quantity: null },
            { itemId: p2, quantity: null },
          ],
        },
        // a line of ANOTHER order
        { changes: [{ itemId: line(other, 'P-1').id, quantity: '1' }] },
      ];
      for (const command of bad) {
        expect(
          await failure(w.edit(w.actors.manager, order.id, command as never)),
          JSON.stringify(command),
        ).toBeInstanceOf(InputValidationError);
      }
      expect((await w.orders.getOrderFor(w.actors.manager, order.id)).totalAmount.toFixed(2)).toBe(
        '3750.50',
      );
      expect(await events(order.id)).toHaveLength(1);
    });

    it('races with an approval: exactly one wins and the lines stay consistent', async () => {
      const order = await submitOrder(w);
      const repository = t.get(OrdersRepository);
      const originalEdit = repository.updateGuarded.bind(repository);
      const originalTransition = repository.transitionGuarded.bind(repository);
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const meet = async (): Promise<void> => {
        arrived += 1;
        if (arrived >= 2) open();
        await gate;
      };
      vi.spyOn(repository, 'updateGuarded').mockImplementation(async (...args) => {
        await meet();
        return originalEdit(...args);
      });
      vi.spyOn(repository, 'transitionGuarded').mockImplementation(async (...args) => {
        await meet();
        return originalTransition(...args);
      });

      const results = await Promise.allSettled([
        w.edit(w.actors.manager, order.id, {
          changes: [{ itemId: line(order, 'P-1').id, quantity: '1' }],
        }),
        w.step(w.actors.manager2, order.id, { to: 'MANAGER_APPROVED' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect(lost?.status === 'rejected' && lost.reason).toMatchObject({ reason: 'ORDER_CHANGED' });

      const row = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const items = await w.prisma.orderItem.findMany({ where: { orderId: order.id } });
      const sum = items.reduce((total, i) => total + Number(i.lineTotal), 0);
      expect(Number(row.totalAmount)).toBe(sum);
      expect(row.rowVersion).toBe(2);
    });
  });
});
