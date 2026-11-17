import type { OrderStatus } from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../src/common/errors/domain-errors.js';
import { OrdersModule, type OrderView } from '../src/modules/orders/index.js';
import { CUSTOMER_PAYLOAD_KEYS } from '../src/modules/orders/order-notifications.js';
import { SupplyAllocationService } from '../src/modules/pricing/index.js';
import { OrdersRepository } from '../src/modules/orders/orders.repository.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import {
  createWorld,
  fifoPlanOf,
  orderAt,
  submitOrder,
  type World,
  placeCart,
} from './support/orders-world.js';

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected the call to fail');
}

describe('order transitions (real PostgreSQL)', () => {
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

  /** "TYPE>KIND:who" per outbox row, sorted, with readable names for the people. */
  async function outbox(orderId: string): Promise<string[]> {
    const names = new Map<string, string>([
      [w.orgA, 'orgA'],
      [w.orgB, 'orgB'],
      ...Object.entries(w.ids).map(([name, id]) => [id, name] as [string, string]),
    ]);
    const rows = await w.prisma.notificationOutbox.findMany({ where: { orderId } });
    return rows
      .map((r) => {
        const who =
          r.recipientRole ?? names.get(r.recipientUserId ?? r.recipientOrganizationId ?? '') ?? '?';
        return `${r.type}>${r.recipientKind}:${who}`;
      })
      .sort();
  }

  const reasonOf = (error: unknown): string | undefined =>
    error instanceof ConflictError ? error.reason : undefined;

  describe('the whole journey', () => {
    it('walks SUBMITTED to RECEIVED with one event and the right messages per step', async () => {
      const order = await submitOrder(w);
      expect(order.status).toBe('SUBMITTED');

      t.clock.set(new Date('2026-10-20T09:00:00Z'));
      const approved = await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
      });
      t.clock.set(new Date('2026-10-20T10:00:00Z'));
      const cleared = await w.step(w.actors.accountant, order.id, {
        to: 'ACCOUNTING_CLEARED',
      });
      const released = await w.step(w.actors.warehouse, order.id, {
        to: 'RELEASED',
        driverUserId: w.ids.driver,
        reason: 'loaded on the van',
      });
      const delivered = await w.step(w.actors.driver, order.id, { to: 'DELIVERED' });
      const received = await w.step(w.actors.ownerA, order.id, { to: 'RECEIVED' });

      expect(
        [approved, cleared, released, delivered, received].map((o) => [o.status, o.rowVersion]),
      ).toEqual([
        ['MANAGER_APPROVED', 2],
        ['ACCOUNTING_CLEARED', 3],
        ['RELEASED', 4],
        ['DELIVERED', 5],
        ['RECEIVED', 6],
      ]);

      const log = await events(order.id);
      expect(
        log.map((e) => [e.eventType, e.fromStatus, e.toStatus, e.actorUserId, e.actorRole]),
      ).toEqual([
        ['SUBMITTED', null, 'SUBMITTED', w.ids.sellerA, 'SELLER'],
        ['STATUS_CHANGED', 'SUBMITTED', 'MANAGER_APPROVED', w.ids.manager, 'MANAGER'],
        [
          'STATUS_CHANGED',
          'MANAGER_APPROVED',
          'ACCOUNTING_CLEARED',
          w.ids.accountant,
          'ACCOUNTANT',
        ],
        ['STATUS_CHANGED', 'ACCOUNTING_CLEARED', 'RELEASED', w.ids.warehouse, 'WAREHOUSE_MANAGER'],
        ['STATUS_CHANGED', 'RELEASED', 'DELIVERED', w.ids.driver, 'DRIVER'],
        ['STATUS_CHANGED', 'DELIVERED', 'RECEIVED', w.ids.ownerA, 'SHOP_OWNER'],
      ]);
      expect(log[3]?.comment).toBe('loaded on the van');
      expect(log[3]?.payload).toEqual({
        before: { status: 'ACCOUNTING_CLEARED', driverUserId: null },
        after: {
          status: 'RELEASED',
          driverUserId: w.ids.driver,
          releasedUnits: 3,
          releasedUnitCodes: 0,
          holdsEnded: 2,
        },
      });
      expect(log[2]?.payload).toEqual({
        before: {
          status: 'MANAGER_APPROVED',
          accountingMode: 'PENDING',
          accountingClearedAt: null,
        },
        after: {
          status: 'ACCOUNTING_CLEARED',
          accountingMode: 'APPROVED',
          accountingClearedAt: '2026-10-20T10:00:00.000Z',
        },
      });

      // [C] 2026-11-09: of the whole journey the customer's chat hears about the approval only;
      // clearance, release and delivery are silent for it (staff messages are unchanged).
      expect(await outbox(order.id)).toEqual(
        [
          'ORDER_SUBMITTED>ROLE:MANAGER',
          'ORDER_MANAGER_APPROVED>ROLE:ACCOUNTANT',
          'ORDER_READY_TO_PREPARE>ROLE:WAREHOUSE_MANAGER',
          'ORDER_MANAGER_APPROVED>ORGANIZATION_CHAT:orgA',
          'ORDER_ACCOUNTING_CLEARED>ROLE:WAREHOUSE_MANAGER',
          'ORDER_RELEASED>USER:driver',
          'ORDER_RECEIVED>ROLE:MANAGER',
        ].sort(),
      );

      // Nothing addressed to the customer carries a staff id, role or accounting detail.
      const toCustomer = await w.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, recipientKind: 'ORGANIZATION_CHAT' },
      });
      expect(toCustomer).toHaveLength(1);
      for (const row of toCustomer) {
        expect(
          Object.keys(row.payload as object).filter((key) => !CUSTOMER_PAYLOAD_KEYS.includes(key)),
        ).toEqual([]);
        for (const staffId of Object.values(w.ids)) {
          expect(JSON.stringify(row.payload)).not.toContain(staffId);
        }
      }

      const row = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row).toMatchObject({
        status: 'RECEIVED',
        accountingMode: 'APPROVED',
        driverUserId: w.ids.driver,
        rowVersion: 6,
      });
      expect(row.accountingClearedAt).toEqual(new Date('2026-10-20T10:00:00Z'));
      expect(row.updatedAt).toEqual(new Date('2026-10-20T10:00:00Z'));
    });
  });

  describe('the manager skips accounting while approving', () => {
    it('moves to ACCOUNTING_CLEARED in one transaction with two events by the manager', async () => {
      const order = await submitOrder(w);
      t.clock.set(new Date('2026-10-25T08:30:00Z')); // a Sunday: the skip has nothing to do with the calendar
      const result = await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
        skipAccounting: true,
        reason: 'regular customer',
      });
      expect(result.status).toBe('ACCOUNTING_CLEARED');
      expect(result.rowVersion).toBe(2);
      expect(result.staff).toMatchObject({
        accountingMode: 'SKIPPED_BY_MANAGER',
        accountingClearedAt: new Date('2026-10-25T08:30:00Z'),
      });

      const log = await events(order.id);
      expect(
        log.map((e) => [
          e.eventType,
          e.fromStatus,
          e.toStatus,
          e.actorUserId,
          e.actorRole,
          e.comment,
        ]),
      ).toEqual([
        ['SUBMITTED', null, 'SUBMITTED', w.ids.sellerA, 'SELLER', null],
        [
          'STATUS_CHANGED',
          'SUBMITTED',
          'MANAGER_APPROVED',
          w.ids.manager,
          'MANAGER',
          'regular customer',
        ],
        [
          'ACCOUNTING_SKIPPED',
          'MANAGER_APPROVED',
          'ACCOUNTING_CLEARED',
          w.ids.manager,
          'MANAGER',
          null,
        ],
      ]);
      expect(log[2]?.payload).toEqual({
        before: {
          status: 'MANAGER_APPROVED',
          accountingMode: 'PENDING',
          accountingClearedAt: null,
        },
        after: {
          status: 'ACCOUNTING_CLEARED',
          accountingMode: 'SKIPPED_BY_MANAGER',
          accountingClearedAt: '2026-10-25T08:30:00.000Z',
        },
      });
      // the accountant still sees a new order, the warehouse is told at once; the customer's
      // chat gets the approval and not the clearance ([C] 2026-11-09)
      expect(await outbox(order.id)).toEqual(
        [
          'ORDER_SUBMITTED>ROLE:MANAGER',
          'ORDER_MANAGER_APPROVED>ROLE:ACCOUNTANT',
          'ORDER_MANAGER_APPROVED>ORGANIZATION_CHAT:orgA',
          'ORDER_ACCOUNTING_CLEARED>ROLE:WAREHOUSE_MANAGER',
        ].sort(),
      );
      const accountantRow = await w.prisma.notificationOutbox.findFirstOrThrow({
        where: { orderId: order.id, type: 'ORDER_MANAGER_APPROVED', recipientRole: 'ACCOUNTANT' },
      });
      expect(accountantRow.payload).toMatchObject({ accountingSkipped: true });
    });

    it('is visible to the warehouse and the accountant, and goes on to release', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
        skipAccounting: true,
      });
      expect((await w.orders.getOrderFor(w.actors.warehouse, order.id)).status).toBe(
        'ACCOUNTING_CLEARED',
      );
      expect((await w.orders.listOrdersFor(w.actors.accountant)).orders.map((o) => o.id)).toContain(
        order.id,
      );
      const released = await w.step(w.actors.warehouse, order.id, {
        to: 'RELEASED',
        driverUserId: w.ids.driver,
      });
      expect(released.status).toBe('RELEASED');
    });

    it('counts as cleared: a cancelled skipped order stays visible to the warehouse', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
        skipAccounting: true,
      });
      await w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason: 'changed' });
      expect((await w.orders.getOrderFor(w.actors.warehouse, order.id)).status).toBe('CANCELLED');
    });

    it('is only for the manager, only when approving a submitted order', async () => {
      const order = await submitOrder(w);
      for (const actor of [w.actors.admin, w.actors.accountant]) {
        const error = await failure(
          w.step(actor, order.id, { to: 'MANAGER_APPROVED', skipAccounting: true }),
        );
        expect(error).toBeInstanceOf(ForbiddenError);
      }
      const invalid = await failure(
        w.step(w.actors.manager, order.id, {
          to: 'CANCELLED',
          reason: 'x',
          skipAccounting: true,
        }),
      );
      expect(invalid).toBeInstanceOf(InputValidationError);
      expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe('SUBMITTED');
    });

    it('does not skip when not ticked: the order waits for the accountant, on any day', async () => {
      t.clock.set(new Date('2026-10-25T08:30:00Z')); // Sunday
      const order = await submitOrder(w);
      const result = await w.step(w.actors.manager, order.id, {
        to: 'MANAGER_APPROVED',
        skipAccounting: false,
      });
      expect(result.status).toBe('MANAGER_APPROVED');
      expect(result.staff).toMatchObject({ accountingMode: 'PENDING', accountingClearedAt: null });
    });
  });

  describe('rejection', () => {
    it('manager rejects with a reason and the customer is told', async () => {
      const order = await submitOrder(w);
      const result = await w.step(w.actors.manager, order.id, {
        to: 'REJECTED',
        reason: '  out of stock  ',
      });
      expect(result.status).toBe('REJECTED');
      expect((await events(order.id)).at(-1)?.comment).toBe('out of stock');
      expect(await outbox(order.id)).toContain('ORDER_REJECTED>ORGANIZATION_CHAT:orgA');
      const message = await w.prisma.notificationOutbox.findFirstOrThrow({
        where: { orderId: order.id, type: 'ORDER_REJECTED' },
      });
      expect(message.payload).toMatchObject({ reason: 'out of stock', status: 'REJECTED' });
    });

    it('needs a reason', async () => {
      const order = await submitOrder(w);
      for (const reason of [undefined, null, '', '   ']) {
        const error = await failure(w.step(w.actors.manager, order.id, { to: 'REJECTED', reason }));
        expect(error).toBeInstanceOf(InputValidationError);
      }
      expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe('SUBMITTED');
      expect(await events(order.id)).toHaveLength(1);
    });

    it('the accountant rejects a manager-approved order; manager, warehouse and customer are told', async () => {
      const order = await orderAt(w, 'MANAGER_APPROVED');
      const result = await w.step(w.actors.accountant, order.id, {
        to: 'REJECTED',
        reason: 'credit limit',
      });
      expect(result.status).toBe('REJECTED');
      const rejections = (await outbox(order.id)).filter((m) => m.startsWith('ORDER_REJECTED'));
      expect(rejections).toEqual([
        'ORDER_REJECTED>ORGANIZATION_CHAT:orgA',
        'ORDER_REJECTED>ROLE:MANAGER',
        'ORDER_REJECTED>ROLE:WAREHOUSE_MANAGER',
      ]);
      const row = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.accountingClearedAt).toBeNull();
    });

    it('only the right role rejects at each step', async () => {
      const submitted = await submitOrder(w);
      for (const actor of [w.actors.accountant, w.actors.admin, w.actors.ownerA]) {
        expect(
          await failure(w.step(actor, submitted.id, { to: 'REJECTED', reason: 'x' })),
        ).toBeInstanceOf(ForbiddenError);
      }
      const approved = await orderAt(w, 'MANAGER_APPROVED');
      expect(
        await failure(w.step(w.actors.manager, approved.id, { to: 'REJECTED', reason: 'x' })),
      ).toBeInstanceOf(ForbiddenError);
    });
  });

  describe('cancellation', () => {
    it('the manager cancels a submitted order with a reason; the event keeps it', async () => {
      const order = await submitOrder(w, w.actors.sellerA);
      const result = await w.step(w.actors.manager, order.id, {
        to: 'CANCELLED',
        reason: 'ordered by mistake',
      });
      expect(result.status).toBe('CANCELLED');
      expect((await events(order.id)).at(-1)).toMatchObject({
        eventType: 'STATUS_CHANGED',
        toStatus: 'CANCELLED',
        comment: 'ordered by mistake',
        actorUserId: w.actors.manager.userId,
      });
    });

    it('requires a reason', async () => {
      const order = await submitOrder(w);
      for (const reason of [undefined, '', '  ']) {
        expect(
          await failure(w.step(w.actors.manager, order.id, { to: 'CANCELLED', reason })),
        ).toBeInstanceOf(InputValidationError);
      }
      expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe('SUBMITTED');
    });

    it('customers (placer, colleague seller, shop owner) can never cancel, in any status', async () => {
      for (const status of ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'] as const) {
        const order = await orderAt(w, status, { placedBy: w.actors.sellerA });
        for (const customer of [w.actors.sellerA, w.actors.sellerA2, w.actors.ownerA]) {
          expect(
            await failure(w.step(customer, order.id, { to: 'CANCELLED', reason: 'x' })),
            `${customer.userId} at ${status}`,
          ).toBeInstanceOf(ForbiddenError);
        }
        expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe(status);
        expect(await outbox(order.id)).not.toContain('ORDER_CANCELLED>USER:sellerA');
      }
    });

    it('admin can never cancel', async () => {
      for (const status of ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'] as const) {
        const order = await orderAt(w, status);
        expect(
          await failure(w.step(w.actors.admin, order.id, { to: 'CANCELLED', reason: 'x' })),
        ).toBeInstanceOf(ForbiddenError);
        expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe(status);
      }
    });

    it('tells the customer chat, and the placer, when the manager cancels', async () => {
      const order = await submitOrder(w, w.actors.sellerA);
      await w.step(w.actors.manager, order.id, {
        to: 'CANCELLED',
        reason: 'no stock',
      });
      expect((await outbox(order.id)).filter((m) => m.startsWith('ORDER_CANCELLED'))).toEqual([
        'ORDER_CANCELLED>ORGANIZATION_CHAT:orgA',
        'ORDER_CANCELLED>USER:sellerA',
      ]);
    });

    it('the manager cancels while SUBMITTED, MANAGER_APPROVED or ACCOUNTING_CLEARED', async () => {
      for (const status of ['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED'] as const) {
        const order = await orderAt(w, status);
        const result = await w.step(w.actors.manager, order.id, {
          to: 'CANCELLED',
          reason: `cancelled at ${status}`,
        });
        expect(result.status, `at ${status}`).toBe('CANCELLED');
      }
    });

    it('nobody cancels after RELEASED, and the accountant, warehouse and driver never cancel', async () => {
      const released = await orderAt(w, 'RELEASED');
      expect(
        reasonOf(
          await failure(w.step(w.actors.manager, released.id, { to: 'CANCELLED', reason: 'x' })),
        ),
      ).toBe('ILLEGAL_ORDER_TRANSITION');
      const cleared = await orderAt(w, 'ACCOUNTING_CLEARED');
      for (const actor of [w.actors.accountant, w.actors.warehouse]) {
        expect(
          await failure(w.step(actor, cleared.id, { to: 'CANCELLED', reason: 'x' })),
        ).toBeInstanceOf(ForbiddenError);
      }
      // the driver is not assigned, so the order does not even exist for them
      expect(
        await failure(w.step(w.actors.driver, cleared.id, { to: 'CANCELLED', reason: 'x' })),
      ).toBeInstanceOf(NotFoundError);
    });

    it('tells the warehouse when an approved order is cancelled, but not before approval', async () => {
      const cleared = await orderAt(w, 'ACCOUNTING_CLEARED');
      await w.step(w.actors.manager, cleared.id, { to: 'CANCELLED', reason: 'x' });
      expect(await outbox(cleared.id)).toContain('ORDER_CANCELLED>ROLE:WAREHOUSE_MANAGER');

      const waiting = await orderAt(w, 'MANAGER_APPROVED');
      await w.step(w.actors.manager, waiting.id, { to: 'CANCELLED', reason: 'x' });
      expect(await outbox(waiting.id)).toContain('ORDER_CANCELLED>ROLE:WAREHOUSE_MANAGER');

      const submitted = await submitOrder(w);
      await w.step(w.actors.manager, submitted.id, { to: 'CANCELLED', reason: 'x' });
      expect(await outbox(submitted.id)).not.toContain('ORDER_CANCELLED>ROLE:WAREHOUSE_MANAGER');
    });
  });

  describe('illegal and forbidden moves are rejected on the server', () => {
    it('answers ILLEGAL_ORDER_TRANSITION for a move the lifecycle does not have', async () => {
      const submitted = await submitOrder(w);
      const attempts: [Actor, OrderStatus][] = [
        [w.actors.accountant, 'ACCOUNTING_CLEARED'], // skips the manager step
        [w.actors.ownerA, 'RECEIVED'],
        [w.actors.manager, 'SUBMITTED'],
      ];
      for (const [actor, to] of attempts) {
        const error = await failure(
          w.step(actor, submitted.id, { to, driverUserId: w.ids.driver }),
        );
        expect(reasonOf(error), `${actor.userId} -> ${to}`).toBe('ILLEGAL_ORDER_TRANSITION');
      }
      expect((await w.orders.getOrderFor(w.actors.manager, submitted.id)).rowVersion).toBe(1);
    });

    it('does not move backwards or out of a final status', async () => {
      const approved = await orderAt(w, 'MANAGER_APPROVED');
      expect(
        reasonOf(await failure(w.step(w.actors.manager, approved.id, { to: 'SUBMITTED' }))),
      ).toBe('ILLEGAL_ORDER_TRANSITION');
      expect(
        reasonOf(await failure(w.step(w.actors.manager, approved.id, { to: 'MANAGER_APPROVED' }))),
        // already there: somebody was faster
      ).toBe('ORDER_CHANGED');
      for (const final of ['RECEIVED', 'REJECTED', 'CANCELLED'] as const) {
        const done = await orderAt(w, final);
        for (const to of ['SUBMITTED', 'MANAGER_APPROVED', 'CANCELLED', 'REJECTED'] as const) {
          // "Already there or further" is a lost race (ORDER_CHANGED), the rest is illegal.
          // Every final status lies at or beyond MANAGER_APPROVED on some path.
          const alreadyThere = final === to || to === 'MANAGER_APPROVED';
          expect(
            reasonOf(await failure(w.step(w.actors.manager, done.id, { to, reason: 'x' }))),
            `${final} -> ${to}`,
          ).toBe(alreadyThere ? 'ORDER_CHANGED' : 'ILLEGAL_ORDER_TRANSITION');
        }
      }
    });

    it('admin never performs a workflow step', async () => {
      const submitted = await submitOrder(w);
      expect(
        await failure(w.step(w.actors.admin, submitted.id, { to: 'MANAGER_APPROVED' })),
      ).toBeInstanceOf(ForbiddenError);
      const approved = await orderAt(w, 'MANAGER_APPROVED');
      expect(
        await failure(w.step(w.actors.admin, approved.id, { to: 'ACCOUNTING_CLEARED' })),
      ).toBeInstanceOf(ForbiddenError);
      const cleared = await orderAt(w, 'ACCOUNTING_CLEARED');
      expect(
        await failure(
          w.step(w.actors.admin, cleared.id, {
            to: 'RELEASED',
            driverUserId: w.ids.driver,
          }),
        ),
      ).toBeInstanceOf(ForbiddenError);
    });

    it('a manager cannot approve twice', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      expect(
        reasonOf(await failure(w.step(w.actors.manager2, order.id, { to: 'MANAGER_APPROVED' }))),
      ).toBe('ORDER_CHANGED');
    });

    it('rejects a command with unknown fields or a bad status', async () => {
      const order = await submitOrder(w);
      for (const command of [
        { to: 'NOPE' },
        { to: 'MANAGER_APPROVED', status: 'RELEASED' },
        { to: 'MANAGER_APPROVED', driverUserId: 'not-a-uuid' },
      ]) {
        expect(
          await failure(
            w.step(w.actors.manager, order.id, command as unknown as { to: 'RELEASED' }),
          ),
        ).toBeInstanceOf(InputValidationError);
      }
    });
  });

  describe('resource rules', () => {
    it('release names an ACTIVE driver', async () => {
      const order = await orderAt(w, 'ACCOUNTING_CLEARED');
      expect(
        await failure(w.step(w.actors.warehouse, order.id, { to: 'RELEASED' })),
      ).toBeInstanceOf(InputValidationError);
      for (const driverUserId of [
        w.ids.manager,
        w.ids.sellerA,
        '019a0000-0000-7000-8000-000000000000',
      ]) {
        expect(
          await failure(w.step(w.actors.warehouse, order.id, { to: 'RELEASED', driverUserId })),
        ).toBeInstanceOf(InputValidationError);
      }
      await w.prisma.user.update({ where: { id: w.ids.driver2 }, data: { status: 'BLOCKED' } });
      expect(
        await failure(
          w.step(w.actors.warehouse, order.id, {
            to: 'RELEASED',
            driverUserId: w.ids.driver2,
          }),
        ),
      ).toBeInstanceOf(InputValidationError);
      // The driver is checked inside the release transaction after the role check, so someone
      // who may not release learns nothing about the driver.
      expect(
        await failure(
          w.step(w.actors.manager, order.id, { to: 'RELEASED', driverUserId: w.ids.driver2 }),
        ),
      ).toBeInstanceOf(ForbiddenError);
      expect((await w.orders.getOrderFor(w.actors.warehouse, order.id)).status).toBe(
        'ACCOUNTING_CLEARED',
      );
    });

    it('only the assigned driver marks the order delivered', async () => {
      const released = await orderAt(w, 'RELEASED');
      // driver2 does not even see the order
      expect(
        await failure(w.step(w.actors.driver2, released.id, { to: 'DELIVERED' })),
      ).toBeInstanceOf(NotFoundError);
      expect(
        await failure(w.step(w.actors.warehouse, released.id, { to: 'DELIVERED' })),
      ).toBeInstanceOf(ForbiddenError);
      const delivered = await w.step(w.actors.driver, released.id, {
        to: 'DELIVERED',
        reason: 'left at the door',
      });
      expect(delivered.status).toBe('DELIVERED');
    });

    it('the shop owner confirms receipt for the organization, a seller only for their own order', async () => {
      const mine = await orderAt(w, 'DELIVERED', { placedBy: w.actors.sellerA });
      expect(await failure(w.step(w.actors.sellerA2, mine.id, { to: 'RECEIVED' }))).toBeInstanceOf(
        ForbiddenError,
      );
      expect((await w.step(w.actors.sellerA, mine.id, { to: 'RECEIVED' })).status).toBe('RECEIVED');

      const colleagues = await orderAt(w, 'DELIVERED', { placedBy: w.actors.sellerA });
      expect((await w.step(w.actors.ownerA, colleagues.id, { to: 'RECEIVED' })).status).toBe(
        'RECEIVED',
      );
    });

    it('another organization cannot even tell the order exists', async () => {
      const order = await submitOrder(w, w.actors.sellerA);
      for (const to of ['CANCELLED', 'MANAGER_APPROVED', 'RECEIVED'] as const) {
        expect(
          await failure(w.step(w.actors.sellerB, order.id, { to, reason: 'x' })),
        ).toBeInstanceOf(NotFoundError);
      }
      expect(
        await failure(
          w.step(w.actors.sellerB, '019a0000-0000-7000-8000-000000000000', {
            to: 'CANCELLED',
            reason: 'x',
          }),
        ),
      ).toBeInstanceOf(NotFoundError);
      expect(
        await failure(w.step(w.actors.sellerB, 'not-a-uuid', { to: 'CANCELLED', reason: 'x' })),
      ).toBeInstanceOf(NotFoundError);
      expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe('SUBMITTED');
    });

    it('the warehouse and the driver cannot act on orders they may not see', async () => {
      const submitted = await submitOrder(w);
      expect(
        await failure(
          w.step(w.actors.warehouse, submitted.id, {
            to: 'RELEASED',
            driverUserId: w.ids.driver,
          }),
        ),
      ).toBeInstanceOf(NotFoundError);
      expect(
        await failure(w.step(w.actors.driver, submitted.id, { to: 'DELIVERED' })),
      ).toBeInstanceOf(NotFoundError);
    });

    it('a user with two staff roles can do either role step', async () => {
      const both: Actor = { userId: w.ids.manager, staffRoles: ['MANAGER', 'ACCOUNTANT'] };
      const order = await submitOrder(w);
      await w.step(both, order.id, { to: 'MANAGER_APPROVED' });
      const cleared = await w.step(both, order.id, { to: 'ACCOUNTING_CLEARED' });
      expect(cleared.status).toBe('ACCOUNTING_CLEARED');
      expect((await events(order.id)).at(-1)?.actorRole).toBe('ACCOUNTANT');
    });
  });

  describe('concurrency', () => {
    it('two managers approving at once: exactly one transition happens', async () => {
      const order = await submitOrder(w);
      const results = await Promise.allSettled([
        w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' }),
        w.step(w.actors.manager2, order.id, { to: 'MANAGER_APPROVED' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect(lost?.status === 'rejected' && reasonOf(lost.reason)).toBe('ORDER_CHANGED');
      expect(lost?.status === 'rejected' && (lost.reason as ConflictError).details).toEqual({
        currentStatus: 'MANAGER_APPROVED',
      });

      const row = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.rowVersion).toBe(2);
      expect(
        (await events(order.id)).filter((e) => e.toStatus === 'MANAGER_APPROVED'),
      ).toHaveLength(1);
      expect(
        await w.prisma.notificationOutbox.count({
          where: { orderId: order.id, type: 'ORDER_MANAGER_APPROVED', recipientRole: 'ACCOUNTANT' },
        }),
      ).toBe(1);
    });

    it('many parallel approvals still produce exactly one', async () => {
      const order = await submitOrder(w);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          w.step(i % 2 === 0 ? w.actors.manager : w.actors.manager2, order.id, {
            to: 'MANAGER_APPROVED',
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await w.prisma.orderEvent.count({ where: { orderId: order.id } })).toBe(2);
    });

    it('an approval racing a cancellation: one wins, the final state is consistent', async () => {
      const order = await submitOrder(w);
      const results = await Promise.allSettled([
        w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' }),
        w.step(w.actors.manager2, order.id, {
          to: 'CANCELLED',
          reason: 'changed my mind',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const log = await events(order.id);
      expect(log).toHaveLength(2);
      expect(log[1]?.toStatus).toBe(row.status);
      expect(['MANAGER_APPROVED', 'CANCELLED']).toContain(row.status);
    });

    it('fails with ORDER_CHANGED when the caller read an older version', async () => {
      const order = await submitOrder(w);
      await w.edit(w.actors.manager, order.id, {
        changes: [{ itemId: order.items[0]?.id ?? '', quantity: '1' }],
      });
      const error = await failure(
        w.step(w.actors.manager, order.id, {
          to: 'MANAGER_APPROVED',
          expectedRowVersion: order.rowVersion,
        }),
      );
      expect(reasonOf(error)).toBe('ORDER_CHANGED');
      // with the current version it works
      const fresh = await w.orders.getOrderFor(w.actors.manager, order.id);
      expect(
        (
          await w.step(w.actors.manager, order.id, {
            to: 'MANAGER_APPROVED',
            expectedRowVersion: fresh.rowVersion,
          })
        ).status,
      ).toBe('MANAGER_APPROVED');
    });
  });

  describe('staff decide on what they saw (expectedRowVersion)', () => {
    it('is required for every staff transition and for edits', async () => {
      const staffMoves: [Actor, OrderStatus, OrderStatus, object][] = [
        [w.actors.manager, 'SUBMITTED', 'MANAGER_APPROVED', {}],
        [w.actors.manager, 'SUBMITTED', 'REJECTED', { reason: 'no' }],
        [w.actors.manager, 'SUBMITTED', 'CANCELLED', { reason: 'no' }],
        [w.actors.accountant, 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', {}],
        [w.actors.accountant, 'MANAGER_APPROVED', 'REJECTED', { reason: 'no' }],
        [w.actors.warehouse, 'ACCOUNTING_CLEARED', 'RELEASED', { driverUserId: w.ids.driver }],
        [w.actors.driver, 'RELEASED', 'DELIVERED', {}],
      ];
      for (const [actor, at, to, extra] of staffMoves) {
        const order = await orderAt(w, at);
        const error = await failure(w.orders.transition(actor, order.id, { to, ...extra }));
        expect(error, `${actor.userId} ${at} -> ${to}`).toBeInstanceOf(InputValidationError);
        expect(
          (error as InputValidationError).issues.map((issue) => issue.path),
          `${at} -> ${to}`,
        ).toContain('expectedRowVersion');
        expect((await w.orders.getOrderFor(w.actors.manager, order.id)).status).toBe(at);
      }
      const order = await submitOrder(w);
      const edit = await failure(
        w.orders.editItems(w.actors.manager, order.id, {
          changes: [{ itemId: order.items[0]?.id ?? '', quantity: '1' }],
        }),
      );
      expect(edit).toBeInstanceOf(InputValidationError);
    });

    it('stays optional for the customer confirming their own order', async () => {
      const delivered = await orderAt(w, 'DELIVERED');
      const received = await w.orders.transition(w.actors.ownerA, delivered.id, { to: 'RECEIVED' });
      expect(received.status).toBe('RECEIVED');
    });

    it('a manager approving a version another manager already edited fails and changes nothing', async () => {
      const order = await submitOrder(w);
      await w.edit(w.actors.manager2, order.id, {
        changes: [{ itemId: order.items[0]?.id ?? '', quantity: '1' }],
      });
      const error = await failure(
        w.orders.transition(w.actors.manager, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: order.rowVersion,
        }),
      );
      expect(reasonOf(error)).toBe('ORDER_CHANGED');
      const now = await w.orders.getOrderFor(w.actors.manager, order.id);
      expect(now.status).toBe('SUBMITTED');
      expect(now.rowVersion).toBe(order.rowVersion + 1);
    });

    it('a stale edit fails with ORDER_CHANGED even when the order moved on', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      const error = await failure(
        w.orders.editItems(w.actors.manager2, order.id, {
          changes: [{ itemId: order.items[0]?.id ?? '', quantity: '1' }],
          expectedRowVersion: order.rowVersion,
        }),
      );
      expect(reasonOf(error)).toBe('ORDER_CHANGED');
    });
  });

  describe('the loser of a race hears ORDER_CHANGED, whichever order it reads in', () => {
    it('read BEFORE the winner committed: the re-read under the locks finds it moved', async () => {
      const order = await submitOrder(w);
      const supply = t.get(SupplyAllocationService);
      const original = supply.lockSupply.bind(supply);
      let winnerDone: (() => void) | undefined;
      const winner = new Promise<void>((resolve) => {
        winnerDone = resolve;
      });
      let loserRead: (() => void) | undefined;
      const read = new Promise<void>((resolve) => {
        loserRead = resolve;
      });
      // The loser has already read the order; it waits until the winner has committed.
      vi.spyOn(supply, 'lockSupply').mockImplementationOnce(async (tx) => {
        loserRead?.();
        await winner;
        return original(tx);
      });
      const plan = await fifoPlanOf(w.orders, w.actors.manager, order.id);
      const loser = failure(
        w.orders.transition(w.actors.manager2, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: order.rowVersion,
          ...plan,
        }),
      );
      await read;
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      winnerDone?.();
      expect(reasonOf(await loser)).toBe('ORDER_CHANGED');
    });

    it('read AFTER the winner committed: stale version, same target and further all say ORDER_CHANGED', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });

      // a stale version
      const stale = await failure(
        w.orders.transition(w.actors.manager2, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: order.rowVersion,
        }),
      );
      expect(reasonOf(stale)).toBe('ORDER_CHANGED');
      // a stale decision of a role that could never act now still hears "changed", not "illegal"
      const rejectedByManager = await failure(
        w.orders.transition(w.actors.manager2, order.id, {
          to: 'REJECTED',
          reason: 'too late',
          expectedRowVersion: order.rowVersion,
        }),
      );
      expect(reasonOf(rejectedByManager)).toBe('ORDER_CHANGED');
      // the current version, but the order already is at the requested status
      const sameTarget = await failure(
        w.orders.transition(w.actors.manager2, order.id, {
          to: 'MANAGER_APPROVED',
          paymentMethod: 'CASH',
          expectedRowVersion: order.rowVersion + 1,
        }),
      );
      expect(reasonOf(sameTarget)).toBe('ORDER_CHANGED');
      // the order is further along than the request
      await w.step(w.actors.accountant, order.id, { to: 'ACCOUNTING_CLEARED' });
      const beyond = await failure(w.step(w.actors.manager2, order.id, { to: 'MANAGER_APPROVED' }));
      expect(reasonOf(beyond)).toBe('ORDER_CHANGED');
      // a second manager cancelling, on the stale version, an order that is already cancelled
      const second = await submitOrder(w);
      await w.step(w.actors.manager, second.id, { to: 'CANCELLED', reason: 'a' });
      const again = await failure(
        w.orders.transition(w.actors.manager2, second.id, {
          to: 'CANCELLED',
          reason: 'b',
          expectedRowVersion: second.rowVersion,
        }),
      );
      expect(reasonOf(again)).toBe('ORDER_CHANGED');
    });

    it('a request that never was legal is still ILLEGAL_ORDER_TRANSITION', async () => {
      const order = await submitOrder(w);
      const error = await failure(w.step(w.actors.driver, order.id, { to: 'DELIVERED' }));
      // the driver is not assigned, so the order does not exist for them; the manager sees it
      expect(error).toBeInstanceOf(NotFoundError);
      const illegal = await failure(
        w.step(w.actors.manager, order.id, { to: 'RELEASED', driverUserId: w.ids.driver }),
      );
      expect(reasonOf(illegal)).toBe('ILLEGAL_ORDER_TRANSITION');
    });
  });

  describe('one transaction (hard rule 2)', () => {
    async function snapshot(orderId: string) {
      return {
        order: await w.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
        events: await w.prisma.orderEvent.count({ where: { orderId } }),
        outbox: await w.prisma.notificationOutbox.count({ where: { orderId } }),
      };
    }

    it('rolls back the status change and the events when the outbox write fails', async () => {
      const order = await submitOrder(w);
      const before = await snapshot(order.id);
      vi.spyOn(t.get(OrdersRepository), 'insertOutbox').mockRejectedValueOnce(
        new Error('outbox down'),
      );

      await expect(w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' })).rejects.toThrow(
        'outbox down',
      );

      expect(await snapshot(order.id)).toEqual(before);
      expect(before.order.status).toBe('SUBMITTED');
      // and the order is still actionable afterwards
      vi.restoreAllMocks();
      expect((await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' })).status).toBe(
        'MANAGER_APPROVED',
      );
    });

    it('rolls back the status change and the outbox when the event write fails', async () => {
      const order = await submitOrder(w);
      const before = await snapshot(order.id);
      vi.spyOn(t.get(OrdersRepository), 'insertEvents').mockRejectedValueOnce(
        new Error('events down'),
      );

      await expect(
        w.step(w.actors.manager, order.id, {
          to: 'MANAGER_APPROVED',
          skipAccounting: true,
        }),
      ).rejects.toThrow('events down');
      expect(await snapshot(order.id)).toEqual(before);
    });

    it('rolls back everything of a skip when the outbox fails after both events', async () => {
      const order = await submitOrder(w);
      const before = await snapshot(order.id);
      vi.spyOn(t.get(OrdersRepository), 'insertOutbox').mockRejectedValueOnce(
        new Error('outbox down'),
      );
      await expect(
        w.step(w.actors.manager, order.id, {
          to: 'MANAGER_APPROVED',
          skipAccounting: true,
        }),
      ).rejects.toThrow('outbox down');
      expect(await snapshot(order.id)).toEqual(before);
      expect(before.order.accountingMode).toBe('PENDING');
      expect(before.order.accountingClearedAt).toBeNull();
    });

    it('rolls back a submit completely when the outbox write fails', async () => {
      await w.carts.setItemQuantity(w.actors.sellerA, w.products.p1, '1');
      vi.spyOn(t.get(OrdersRepository), 'insertOutbox').mockRejectedValueOnce(
        new Error('outbox down'),
      );
      await expect(
        placeCart(w, w.actors.sellerA, w.orgA, 'rollback-key-0001', 'FULL'),
      ).rejects.toThrow('outbox down');
      expect(await w.prisma.order.count()).toBe(0);
      expect(await w.prisma.orderEvent.count()).toBe(0);
      expect((await w.carts.getCart(w.actors.sellerA)).lines).toHaveLength(1);
    });

    it('a retry cannot duplicate notifications: the dedupe key is unique', async () => {
      const order = await submitOrder(w);
      await w.step(w.actors.manager, order.id, { to: 'MANAGER_APPROVED' });
      const repo = t.get(OrdersRepository);
      const [row] = await w.prisma.notificationOutbox.findMany({
        where: { orderId: order.id, type: 'ORDER_MANAGER_APPROVED', recipientRole: 'ACCOUNTANT' },
      });
      expect(row).toBeDefined();
      if (!row) return;
      const event = await w.prisma.orderEvent.findFirstOrThrow({ where: { orderId: order.id } });
      await repo.transaction((tx) =>
        repo.insertOutbox(
          tx,
          [
            {
              type: 'ORDER_MANAGER_APPROVED',
              recipientKind: 'ROLE',
              recipientUserId: null,
              recipientRole: 'ACCOUNTANT',
              recipientOrganizationId: null,
              orderId: order.id,
              orderEventId: event.id,
              payload: {},
              dedupeKey: row.dedupeKey,
            },
          ],
          new Date(),
        ),
      );
      expect(
        await w.prisma.notificationOutbox.count({
          where: { orderId: order.id, type: 'ORDER_MANAGER_APPROVED', recipientRole: 'ACCOUNTANT' },
        }),
      ).toBe(1);
    });
  });

  it('keeps every returned order free of staff internals for customers', async () => {
    const order = await orderAt(w, 'DELIVERED');
    const asCustomer: OrderView = await w.orders.getOrderFor(w.actors.sellerA, order.id);
    expect(asCustomer.staff).toBeNull();
    const asManager: OrderView = await w.orders.getOrderFor(w.actors.manager, order.id);
    expect(asManager.staff).toMatchObject({
      accountingMode: 'APPROVED',
      driverUserId: w.ids.driver,
    });
  });
});
