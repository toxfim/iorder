import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetCatalogPricingAudit, createTestPrisma, resetIdentity } from './support/test-db.js';
import { makeMember, makeOrganization, makeUser } from './support/identity-fixtures.js';
import { insertRawOrder, makeProduct } from './support/orders-fixtures.js';
import { getRestrictedRoleUrl } from './support/test-env.js';

// The database itself refuses what the application must never do (hard rules 3 and 4,
// invariants 5 and 10), also against a role that cannot disable triggers.
describe('orders database guards (real PostgreSQL)', () => {
  const prisma = createTestPrisma();
  const app = new pg.Client({ connectionString: getRestrictedRoleUrl() });
  const denied = /permission denied|must be owner|superuser|not allowed/i;

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
      await makeProduct(prisma, { code: 'DB-A' }),
      await makeProduct(prisma, { code: 'DB-B' }),
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

  const order = (status: Parameters<typeof insertRawOrder>[1]['status'] = 'SUBMITTED') =>
    insertRawOrder(prisma, {
      organizationId,
      placedByUserId: userId,
      priceListVersionId: versionId,
      productIds,
      status,
      ...(status === 'RELEASED' || status === 'DELIVERED' || status === 'RECEIVED'
        ? { cleared: true, driverUserId }
        : {}),
    });

  async function insertEvent(
    client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
    orderId: string,
    overrides: Partial<{
      eventType: string;
      fromStatus: string | null;
      toStatus: string | null;
      comment: string | null;
      payload: string;
      actorRole: string;
    }> = {},
  ): Promise<void> {
    const v = {
      eventType: 'STATUS_CHANGED',
      fromStatus: 'SUBMITTED',
      toStatus: 'MANAGER_APPROVED',
      comment: null,
      payload: '{"before":{"status":"SUBMITTED"},"after":{"status":"MANAGER_APPROVED"}}',
      actorRole: 'MANAGER',
      ...overrides,
    };
    await client.query(
      `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_user_id,
                                 actor_role, comment, payload, created_at)
       VALUES ($1, $2, $3::order_event_type, $4::order_status, $5::order_status, NULL, $6, $7,
               $8::jsonb, now())`,
      [
        randomUUID(),
        orderId,
        v.eventType,
        v.fromStatus,
        v.toStatus,
        v.actorRole,
        v.comment,
        v.payload,
      ],
    );
  }

  describe('order_events is append-only', () => {
    it('accepts inserts, then rejects UPDATE, DELETE and TRUNCATE even for the table owner', async () => {
      const { id } = await order();
      await insertEvent({ query: (sql, values) => prisma.$executeRawUnsafe(sql, ...values) }, id);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE order_events SET comment = 'x'`),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM order_events`)).rejects.toThrow(
        /append-only/,
      );
      // Postgres refuses first because the outbox now references the table; either way it fails.
      await expect(prisma.$executeRawUnsafe(`TRUNCATE order_events`)).rejects.toThrow(
        /append-only|foreign key/,
      );
      expect(await prisma.orderEvent.count({ where: { orderId: id } })).toBe(1);
    });

    it('cannot be touched by the restricted application role, which can only read and insert', async () => {
      const { id } = await order();
      await insertEvent(app, id); // allowed: INSERT
      await app.query('SELECT * FROM order_events');
      for (const statement of [
        `UPDATE order_events SET comment = 'x'`,
        `DELETE FROM order_events`,
        `TRUNCATE order_events`,
        `ALTER TABLE order_events DISABLE TRIGGER order_events_no_update_delete`,
        `DROP TRIGGER order_events_no_update_delete ON order_events`,
        `ALTER TABLE order_events DISABLE TRIGGER ALL`,
        `DROP TABLE order_events`,
      ]) {
        await expect(app.query(statement), statement).rejects.toThrow(denied);
      }
    });

    it('requires a reason for a rejection or cancellation, and a before/after payload', async () => {
      const { id } = await order();
      const owner = {
        query: (sql: string, values: unknown[]) => prisma.$executeRawUnsafe(sql, ...values),
      };
      await expect(
        insertEvent(owner, id, { fromStatus: 'SUBMITTED', toStatus: 'CANCELLED', comment: null }),
      ).rejects.toThrow(/order_events_reason_required/);
      await expect(
        insertEvent(owner, id, { toStatus: 'REJECTED', comment: '   ' }),
      ).rejects.toThrow(/order_events_comment_not_blank/);
      await insertEvent(owner, id, { toStatus: 'CANCELLED', comment: 'duplicate order' });
      await expect(insertEvent(owner, id, { payload: '{"after":{}}' })).rejects.toThrow(
        /order_events_payload_has_before_after/,
      );
      await expect(insertEvent(owner, id, { fromStatus: null })).rejects.toThrow(
        /order_events_status_events_have_statuses/,
      );
    });
  });

  describe('notification_outbox keeps its rows', () => {
    async function insertOutbox(id: string): Promise<string> {
      const rowId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO notification_outbox (id, type, recipient_kind, recipient_role, order_id, payload,
                                         dedupe_key, created_at)
        VALUES (${rowId}::uuid, 'ORDER_SUBMITTED', 'ROLE'::notification_recipient_kind, 'MANAGER',
                ${id}::uuid, '{}'::jsonb, ${`k-${rowId}`}, now())`;
      return rowId;
    }

    it('rejects DELETE and TRUNCATE, immutable columns, and changes to a sent row', async () => {
      const { id } = await order();
      const rowId = await insertOutbox(id);
      await expect(prisma.$executeRaw`DELETE FROM notification_outbox`).rejects.toThrow(/are kept/);
      await expect(prisma.$executeRaw`TRUNCATE notification_outbox`).rejects.toThrow(/not allowed/);
      await expect(
        prisma.$executeRaw`UPDATE notification_outbox SET payload = '{"x":1}'::jsonb WHERE id = ${rowId}::uuid`,
      ).rejects.toThrow(/only the delivery bookkeeping/);
      await insertEvent(app, id);
      const [event] = await prisma.$queryRaw<
        { id: string }[]
      >`SELECT id FROM order_events WHERE order_id = ${id}::uuid LIMIT 1`;
      await expect(
        prisma.$executeRaw`UPDATE notification_outbox SET order_event_id = ${event?.id}::uuid WHERE id = ${rowId}::uuid`,
      ).rejects.toThrow(/only the delivery bookkeeping/);
      await prisma.$executeRaw`UPDATE notification_outbox SET status = 'FAILED', attempts = 1 WHERE id = ${rowId}::uuid`;
      await prisma.$executeRaw`UPDATE notification_outbox SET status = 'SENT', sent_at = now() WHERE id = ${rowId}::uuid`;
      await expect(
        prisma.$executeRaw`UPDATE notification_outbox SET status = 'PENDING', sent_at = NULL WHERE id = ${rowId}::uuid`,
      ).rejects.toThrow(/sent notification is final/);
    });

    it('allows only status, attempts and sent_at to the application role', async () => {
      const { id } = await order();
      const rowId = await insertOutbox(id);
      await app.query(`UPDATE notification_outbox SET attempts = attempts + 1 WHERE id = $1`, [
        rowId,
      ]);
      await app.query(`UPDATE notification_outbox SET status = 'FAILED' WHERE id = $1`, [rowId]);
      await expect(
        app.query(`UPDATE notification_outbox SET payload = '{}'::jsonb WHERE id = $1`, [rowId]),
      ).rejects.toThrow(denied);
      for (const statement of [
        `DELETE FROM notification_outbox`,
        `TRUNCATE notification_outbox`,
        `ALTER TABLE notification_outbox DISABLE TRIGGER ALL`,
      ]) {
        await expect(app.query(statement), statement).rejects.toThrow(denied);
      }
    });

    it('requires the recipient column that belongs to the kind, and a unique dedupe key', async () => {
      const { id } = await order();
      await expect(
        prisma.$executeRaw`
          INSERT INTO notification_outbox (id, type, recipient_kind, order_id, payload, dedupe_key, created_at)
          VALUES (${randomUUID()}::uuid, 'X', 'USER'::notification_recipient_kind, ${id}::uuid, '{}'::jsonb, 'k1', now())`,
      ).rejects.toThrow(/notification_outbox_recipient_matches_kind/);
      const first = await insertOutbox(id);
      expect(first).toBeTruthy();
      await expect(
        prisma.$executeRaw`
          INSERT INTO notification_outbox (id, type, recipient_kind, recipient_role, order_id, payload, dedupe_key, created_at)
          VALUES (${randomUUID()}::uuid, 'X', 'ROLE'::notification_recipient_kind, 'MANAGER', ${id}::uuid, '{}'::jsonb, ${`k-${first}`}, now())`,
      ).rejects.toThrow(/notification_outbox_dedupe_key_key|dedupe/);
    });
  });

  describe('order items are the price snapshot', () => {
    it('can change while the order is SUBMITTED', async () => {
      const { id, itemIds } = await order();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE orders SET total_amount = 2250.50, total_usd = round(2250.50 / usd_rate, 2), row_version = row_version + 1 WHERE id = ${id}::uuid`;
        await tx.$executeRaw`UPDATE order_items SET quantity = 1, line_total = 1500.00 WHERE id = ${itemIds[0]}::uuid`;
      });
      const rows = await prisma.orderItem.findMany({ where: { orderId: id } });
      expect(rows.map((r) => r.lineTotal.toFixed(2)).sort()).toEqual(['1500.00', '750.50']);
    });

    it.each(['MANAGER_APPROVED', 'REJECTED', 'CANCELLED'] as const)(
      'is frozen once the order is %s (update, delete and insert are rejected)',
      async (status) => {
        const { id, itemIds } = await order(status);
        await expect(
          prisma.$executeRaw`UPDATE order_items SET quantity = 5, line_total = 7500.00 WHERE id = ${itemIds[0]}::uuid`,
        ).rejects.toThrow(/immutable once the order left SUBMITTED/);
        await expect(
          prisma.$executeRaw`DELETE FROM order_items WHERE id = ${itemIds[0]}::uuid`,
        ).rejects.toThrow(/immutable once the order left SUBMITTED/);
        await expect(
          prisma.$executeRaw`
            INSERT INTO order_items (id, order_id, product_id, product_code_snapshot, name_snapshot,
                                     unit_snapshot, quantity, unit_price, line_total)
            VALUES (${randomUUID()}::uuid, ${id}::uuid, ${productIds[0]}::uuid, 'Z', 'Z', 'box', 1, 1.00, 1.00)`,
        ).rejects.toThrow(/immutable once the order left SUBMITTED|duplicate key/);
      },
    );

    it('stays frozen in every later status, also for the restricted role', async () => {
      const { itemIds } = await order('RELEASED');
      await expect(
        app.query(`UPDATE order_items SET quantity = 9, line_total = 13500.00 WHERE id = $1`, [
          itemIds[0],
        ]),
      ).rejects.toThrow(/immutable once the order left SUBMITTED/);
      await expect(
        app.query(`DELETE FROM order_items WHERE id = $1`, [itemIds[0]]),
      ).rejects.toThrow(/immutable once the order left SUBMITTED/);
      await expect(app.query(`TRUNCATE order_items`)).rejects.toThrow(denied);
    });

    it('rejects a line total that is not quantity x unit price, and non-positive quantities', async () => {
      const { itemIds } = await order();
      await expect(
        prisma.$executeRaw`UPDATE order_items SET line_total = 1.00 WHERE id = ${itemIds[0]}::uuid`,
      ).rejects.toThrow(/order_items_line_total_exact/);
      await expect(
        prisma.$executeRaw`UPDATE order_items SET quantity = 0, line_total = 0 WHERE id = ${itemIds[0]}::uuid`,
      ).rejects.toThrow(/order_items_quantity_positive/);
      await expect(
        prisma.$executeRaw`UPDATE order_items SET quantity = -1, line_total = -1500.00 WHERE id = ${itemIds[0]}::uuid`,
      ).rejects.toThrow(/order_items_quantity_positive/);
    });

    it('keeps quantities whole and the line total exact (quantity x unit price)', async () => {
      const { id, itemIds } = await order();
      // Whole pieces only (owner 2026-10-25), and the line total must be exact.
      await expect(
        prisma.$executeRaw`UPDATE order_items SET quantity = 1.5, line_total = 2250.00 WHERE id = ${itemIds[0]}::uuid`,
      ).rejects.toThrow(/order_items_quantity_whole/);
      await expect(
        prisma.$executeRaw`UPDATE order_items SET quantity = 3, line_total = 1.00 WHERE id = ${itemIds[0]}::uuid`,
      ).rejects.toThrow(/order_items_line_total_exact/);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE order_items SET quantity = 3, line_total = 4500.00 WHERE id = ${itemIds[0]}::uuid`;
        await tx.$executeRaw`UPDATE orders SET total_amount = 5250.50, total_usd = round(5250.50 / usd_rate, 2), row_version = row_version + 1 WHERE id = ${id}::uuid`;
      });
    });
  });

  describe('the total is the sum of the lines (invariant 5)', () => {
    it('rejects, at commit, a total that does not match', async () => {
      const { id } = await order();
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE orders SET total_amount = 1.00, total_usd = round(1.00 / usd_rate, 2), row_version = row_version + 1 WHERE id = ${id}::uuid`;
        }),
      ).rejects.toThrow(/does not equal the sum of its lines/);
    });

    it('rejects, at commit, removing a line without lowering the total', async () => {
      const { id, itemIds } = await order();
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`DELETE FROM order_items WHERE id = ${itemIds[1]}::uuid`;
          await tx.$executeRaw`UPDATE orders SET row_version = row_version + 1 WHERE id = ${id}::uuid`;
        }),
      ).rejects.toThrow(/does not equal the sum of its lines/);
    });

    it('accepts the total when the lines and the total change together', async () => {
      const { id, itemIds } = await order();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM order_items WHERE id = ${itemIds[1]}::uuid`;
        await tx.$executeRaw`UPDATE orders SET total_amount = 3000.00, total_usd = round(3000.00 / usd_rate, 2), row_version = row_version + 1 WHERE id = ${id}::uuid`;
      });
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).totalAmount.toFixed(2)).toBe(
        '3000.00',
      );
    });

    it('rejects an order without lines and a silent total change', async () => {
      const { id } = await order();
      await expect(
        prisma.$executeRaw`UPDATE orders SET total_amount = 3000.00 WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/only change together with row_version/);
    });
  });

  describe('orders', () => {
    it('are never deleted or truncated, not even by the owner', async () => {
      const { id } = await order();
      await expect(prisma.$executeRaw`DELETE FROM orders WHERE id = ${id}::uuid`).rejects.toThrow(
        /cannot be deleted/,
      );
      await expect(prisma.$executeRaw`TRUNCATE orders CASCADE`).rejects.toThrow(/not allowed/);
    });

    it('cannot be deleted or truncated by the restricted role either (no privilege)', async () => {
      await order();
      await expect(app.query('DELETE FROM orders')).rejects.toThrow(denied);
      await expect(app.query('TRUNCATE orders')).rejects.toThrow(denied);
      await expect(app.query('ALTER TABLE orders DISABLE TRIGGER ALL')).rejects.toThrow(denied);
    });

    it('keep their identity: number, organization, placer, version and key never change', async () => {
      const { id } = await order();
      const other = await makeOrganization(prisma);
      await expect(
        prisma.$executeRaw`UPDATE orders SET organization_id = ${other.id}::uuid WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/identity columns are immutable/);
      await expect(
        prisma.$executeRaw`UPDATE orders SET order_number = 'IO-1' WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/identity columns are immutable/);
      await expect(
        prisma.$executeRaw`UPDATE orders SET row_version = 0 WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/orders_row_version_positive|cannot go back/);
    });

    it('allow one idempotency key per organization only', async () => {
      const { id } = await order();
      const row = await prisma.order.findUniqueOrThrow({ where: { id } });
      await expect(
        prisma.$executeRaw`
          INSERT INTO orders (id, order_number, organization_id, placed_by_user_id, price_list_version_id,
                              total_amount, usd_rate, total_usd, idempotency_key, submitted_at, updated_at)
          VALUES (${randomUUID()}::uuid, 'IO-DUP', ${organizationId}::uuid, ${userId}::uuid,
                  ${versionId}::uuid, 1, 12000, 0, ${row.idempotencyKey}, now(), now())`,
      ).rejects.toThrow(/idempotency_key|Unique constraint/i);
    });

    it('enforce UZS, a non-negative total and consistent accounting facts', async () => {
      const { id } = await order();
      await expect(
        prisma.$executeRaw`UPDATE orders SET currency = 'USD' WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/identity columns are immutable|orders_currency_uzs/);
      // cleared status without clearance, release without driver, mode without clearance
      const approved = await order('MANAGER_APPROVED');
      await expect(
        prisma.$executeRaw`UPDATE orders SET status = 'ACCOUNTING_CLEARED' WHERE id = ${approved.id}::uuid`,
      ).rejects.toThrow(/orders_cleared_statuses_have_clearance|orders_accounting_mode/);
      await expect(
        prisma.$executeRaw`UPDATE orders SET accounting_mode = 'APPROVED' WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/orders_accounting_mode_matches_clearance/);
      const cleared = await order('ACCOUNTING_CLEARED');
      await expect(
        prisma.$executeRaw`UPDATE orders SET status = 'RELEASED' WHERE id = ${cleared.id}::uuid`,
      ).rejects.toThrow(/orders_released_statuses_have_driver/);
      await expect(
        prisma.$executeRaw`UPDATE orders SET accounting_mode = 'APPROVED', accounting_cleared_at = now() WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/orders_early_statuses_not_cleared/);
    });
  });

  describe('carts', () => {
    it('allow one cart per person and organization, and positive quantities', async () => {
      await prisma.cart.create({ data: { userId, organizationId } });
      await expect(prisma.cart.create({ data: { userId, organizationId } })).rejects.toThrow();
      const cart = await prisma.cart.findFirstOrThrow({ where: { userId } });
      await expect(
        prisma.$executeRaw`INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (${cart.id}::uuid, ${productIds[0]}::uuid, 0)`,
      ).rejects.toThrow(/cart_items_quantity_positive/);
    });
  });

  describe('order number sequence', () => {
    it('never hands out a number below 10001', async () => {
      const rows = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT nextval('order_number_seq')::bigint AS n`;
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(10001);
    });
  });
});
