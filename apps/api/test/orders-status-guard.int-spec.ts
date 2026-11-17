import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ORDER_STATUSES, type OrderStatus } from '@iorder/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findRule } from '../src/modules/orders/order-state-machine.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { insertRawOrder, makeProduct } from './support/orders-fixtures.js';
import { createTestPrisma, resetCatalogPricingAudit, resetIdentity } from './support/test-db.js';
import { getRestrictedRoleUrl } from './support/test-env.js';

// Hard rule 2 at the database level: orders.status moves only along the ten legal moves and only
// together with an order_events row. Proven against the owner (raw SQL) and the restricted role.
describe('orders status guard (real PostgreSQL)', () => {
  const prisma = createTestPrisma();
  const app = new pg.Client({ connectionString: getRestrictedRoleUrl() });
  const TERMINAL: OrderStatus[] = ['RECEIVED', 'REJECTED', 'CANCELLED'];

  let organizationId: string;
  let userId: string;
  let driverUserId: string;
  let versionId: string;
  let productIds: [string, string];

  beforeAll(async () => {
    await prisma.onModuleInit();
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await resetIdentity(prisma);
    await resetCatalogPricingAudit(prisma);
    const org = await makeOrganization(prisma);
    const user = await makeUser(prisma);
    await makeMember(prisma, org.id, user.id, 'SELLER');
    organizationId = org.id;
    userId = user.id;
    driverUserId = (await makeUser(prisma, { staff: ['DRIVER'] })).id;
    productIds = [
      await makeProduct(prisma, { code: 'SG-A' }),
      await makeProduct(prisma, { code: 'SG-B' }),
    ];
    const version = await prisma.priceListVersion.create({
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date('2026-10-01T00:00:00Z'),
        publishedBy: 'fixture',
      },
    });
    versionId = version.id;
  });

  const order = async (status: OrderStatus = 'SUBMITTED'): Promise<string> =>
    (
      await insertRawOrder(prisma, {
        organizationId,
        placedByUserId: userId,
        priceListVersionId: versionId,
        productIds,
        status,
        driverUserId,
      })
    ).id;

  /** Moves the order the way the application does: the status and its event in one transaction. */
  async function moveWithEvent(id: string, from: OrderStatus, to: OrderStatus): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE orders SET status = '${to}' WHERE id = '${id}'::uuid`);
      await tx.orderEvent.create({
        data: {
          orderId: id,
          eventType: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: to,
          actorRole: 'ADMIN',
          comment: 'test',
          payload: { before: { status: from }, after: { status: to } },
          createdAt: new Date(),
        },
      });
    });
  }

  it('has exactly the moves of the TypeScript transition table (SQL and code cannot drift)', async () => {
    const mismatches: string[] = [];
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const rows = await prisma.$queryRaw<
          { allowed: boolean }[]
        >`SELECT order_status_move_allowed(${from}::order_status, ${to}::order_status) AS allowed`;
        const inCode = findRule(from, to) !== undefined;
        if (rows[0]?.allowed !== inCode) mismatches.push(`${from} -> ${to}`);
      }
    }
    expect(mismatches).toEqual([]);
    const allowed = ORDER_STATUSES.flatMap((from) =>
      ORDER_STATUSES.filter((to) => findRule(from, to) !== undefined),
    );
    expect(allowed).toHaveLength(10);
  });

  describe('terminal statuses', () => {
    it.each(TERMINAL)('%s can never be left, to any status', async (terminal) => {
      const id = await order(terminal);
      for (const to of ORDER_STATUSES.filter((status) => status !== terminal)) {
        await expect(
          prisma.$executeRawUnsafe(`UPDATE orders SET status = '${to}' WHERE id = '${id}'::uuid`),
        ).rejects.toThrow(/is final and cannot change/);
      }
    });
  });

  describe('moves that are not in the table', () => {
    const illegal = ORDER_STATUSES.flatMap((from) =>
      ORDER_STATUSES.filter(
        (to) => to !== from && !TERMINAL.includes(from) && findRule(from, to) === undefined,
      ).map((to) => [from, to] as const),
    );

    it.each(illegal)('refuses %s -> %s as the owner', async (from, to) => {
      const id = await order(from);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE orders SET status = '${to}' WHERE id = '${id}'::uuid`),
      ).rejects.toThrow(/cannot move from/);
    });

    it('refuses the skip-accounting jump in one update (it is two moves)', async () => {
      const id = await order('SUBMITTED');
      await expect(
        prisma.$executeRaw`UPDATE orders SET status = 'ACCOUNTING_CLEARED', accounting_mode = 'SKIPPED_BY_MANAGER', accounting_cleared_at = now() WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/cannot move from SUBMITTED to ACCOUNTING_CLEARED/);
    });

    it('refuses an illegal move for the restricted application role with the guard error', async () => {
      const id = await order('SUBMITTED');
      await expect(
        app.query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1`, [id]),
      ).rejects.toThrow(/cannot move from SUBMITTED to DELIVERED/);
      const done = await order('CANCELLED');
      await expect(
        app.query(`UPDATE orders SET status = 'SUBMITTED' WHERE id = $1`, [done]),
      ).rejects.toThrow(/is final/);
    });

    it('refuses to create an order that is not SUBMITTED', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO orders (id, order_number, organization_id, placed_by_user_id, price_list_version_id,
                              status, total_amount, usd_rate, total_usd, idempotency_key, submitted_at, updated_at)
          VALUES (${randomUUID()}::uuid, 'IO-X1', ${organizationId}::uuid, ${userId}::uuid,
                  ${versionId}::uuid, 'REJECTED', 1, 12000, 0, 'status-key-0001', now(), now())`,
      ).rejects.toThrow(/an order starts in SUBMITTED/);
    });
  });

  describe('a status change needs its order_events row at commit', () => {
    it('allows a legal move written together with its event', async () => {
      const id = await order('SUBMITTED');
      await moveWithEvent(id, 'SUBMITTED', 'MANAGER_APPROVED');
      const row = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('MANAGER_APPROVED');
    });

    it('rejects, at commit, a legal move without an event (owner)', async () => {
      const id = await order('SUBMITTED');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE orders SET status = 'MANAGER_APPROVED' WHERE id = ${id}::uuid`;
        }),
      ).rejects.toThrow(/without an order_events row/);
      const row = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('SUBMITTED');
    });

    it('rejects, at commit, a legal move without an event (restricted role)', async () => {
      const id = await order('SUBMITTED');
      await app.query('BEGIN');
      await app.query(`UPDATE orders SET status = 'REJECTED' WHERE id = $1`, [id]);
      await expect(app.query('COMMIT')).rejects.toThrow(/without an order_events row/);
      const { rows } = await app.query<{ status: string }>(
        'SELECT status FROM orders WHERE id = $1',
        [id],
      );
      expect(rows[0]?.status).toBe('SUBMITTED');
    });

    it('rejects an event for a different move than the one made', async () => {
      const id = await order('SUBMITTED');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE orders SET status = 'MANAGER_APPROVED' WHERE id = ${id}::uuid`;
          await tx.orderEvent.create({
            data: {
              orderId: id,
              eventType: 'STATUS_CHANGED',
              fromStatus: 'SUBMITTED',
              toStatus: 'CANCELLED',
              actorRole: 'ADMIN',
              comment: 'wrong move',
              payload: { before: {}, after: {} },
              createdAt: new Date(),
            },
          });
        }),
      ).rejects.toThrow(/without an order_events row/);
    });

    it('does not ask for an event when the status is unchanged', async () => {
      const id = await order('SUBMITTED');
      await prisma.$executeRaw`UPDATE orders SET payment_status = 'PAID', updated_at = now() WHERE id = ${id}::uuid`;
      const row = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(row.paymentStatus).toBe('PAID');
    });
  });
});
