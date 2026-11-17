import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USD_SETTLED_UNDER } from '@iorder/shared';
import { Prisma } from '../src/generated/prisma/client.js';
import { buildTimeline } from '../src/modules/orders/order-timeline.js';
import type { OrderEventRecord } from '../src/modules/orders/orders.repository.js';
import { balanceOf } from '../src/modules/orders/payment-allocation.js';
import { getTestDatabaseUrl } from './support/test-env.js';

const MIGRATION = '20261114090000_usd_organization_debt';
const MIGRATIONS_DIR = new URL('../prisma/migrations/', import.meta.url);

const sqlOf = (name: string): string =>
  readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS_DIR), 'utf8');

const urlOf = (databaseName: string): string => {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const rateValue = (rate: string): string =>
  JSON.stringify({ rate, source: 'MANUAL', rateDate: null, setBy: 'x', followsCentralBank: false });

// Separate databases, because the shared one is already past this migration: every migration before
// it once, cloned per case, then rows as staging has them, then the migration itself.
describe(`migration ${MIGRATION} (real PostgreSQL)`, () => {
  const suffix = randomBytes(6).toString('hex');
  const baseName = `iorder_test_usd_base_${suffix}`;
  const admin = new pg.Client({ connectionString: getTestDatabaseUrl() });
  const clones: string[] = [];
  const open: pg.Client[] = [];

  /** A fresh database at the state right before the migration. */
  async function freshDatabase(): Promise<pg.Client> {
    const name = `iorder_test_usd_${clones.length}_${suffix}`;
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${baseName}`);
    clones.push(name);
    const client = new pg.Client({ connectionString: urlOf(name) });
    await client.connect();
    open.push(client);
    return client;
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${baseName}`);
    const base = new pg.Client({ connectionString: urlOf(baseName) });
    await base.connect();
    const earlier = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
      .map((entry) => entry.name)
      .sort();
    for (const name of earlier) await base.query(sqlOf(name));
    await base.end();
  }, 120_000);

  afterAll(async () => {
    for (const client of open) await client.end();
    for (const name of [...clones, baseName]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.end();
  }, 300_000);

  const organizationId = randomUUID();
  const userId = randomUUID();
  const versionId = randomUUID();
  const productId = randomUUID();

  // Replica mode skips triggers and foreign keys: these rows exist in production only through the
  // workflow, which they do not need to replay. CHECKs still run.
  async function insertOrder(
    db: pg.Client,
    id: string,
    number: string,
    status: 'SUBMITTED' | 'CANCELLED' | 'RECEIVED',
    total: string,
    paymentStatus: 'UNPAID' | 'PAID',
    receivedAt: string | null = null,
  ): Promise<void> {
    const cleared = status === 'RECEIVED';
    await db.query(
      `INSERT INTO orders (id, order_number, organization_id, placed_by_user_id,
                           price_list_version_id, status, payment_status, total_amount,
                           idempotency_key, submitted_at, updated_at, received_at, accounting_mode,
                           accounting_cleared_at, driver_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $2, now(), '2026-10-01T00:00:00Z', $9::timestamptz,
               $10, $11::timestamptz, $12)`,
      [
        id,
        number,
        organizationId,
        userId,
        versionId,
        status,
        paymentStatus,
        total,
        receivedAt,
        cleared ? 'APPROVED' : 'PENDING',
        cleared ? '2026-10-01T00:00:00Z' : null,
        cleared ? userId : null,
      ],
    );
    await db.query(
      `INSERT INTO order_items (id, order_id, product_id, product_code_snapshot, name_snapshot,
                                unit_snapshot, quantity, unit_price, full_unit_price, line_total)
       VALUES ($1, $2, $3, 'P-1', 'Product', 'dona', 1, $4, $4, $4)`,
      [randomUUID(), id, productId, total],
    );
  }

  async function insertPayment(
    db: pg.Client,
    id: string,
    amount: string,
    voided = false,
  ): Promise<void> {
    await db.query(
      `INSERT INTO organization_payments (id, organization_id, amount, paid_on, recorded_by,
                                          recorded_at, updated_at, voided_at, voided_by, void_reason)
       VALUES ($1, $2, $3, '2026-10-01', $4, now(), now(), $5::timestamptz, $6, $7)`,
      [
        id,
        organizationId,
        amount,
        userId,
        voided ? '2026-10-02T00:00:00Z' : null,
        voided ? userId : null,
        voided ? 'duplicate' : null,
      ],
    );
  }

  /** What the customer's timeline API would show for this order, from the migrated rows. */
  async function customerTimelineOf(db: pg.Client, orderId: string): Promise<unknown[]> {
    const { rows } = await db.query<{
      id: string;
      event_type: OrderEventRecord['eventType'];
      actor_role: string;
      actor_user_id: string | null;
      payload: unknown;
      created_at: Date;
    }>(`SELECT * FROM order_events WHERE order_id = $1 ORDER BY seq`, [orderId]);
    return buildTimeline({
      audience: 'CUSTOMER',
      showsPaymentMethod: false,
      order: { placedByUserId: userId },
      events: rows.map((row): OrderEventRecord => ({
        id: row.id,
        eventType: row.event_type,
        fromStatus: null,
        toStatus: null,
        actorUserId: row.actor_user_id,
        actorRole: row.actor_role,
        comment: null,
        payload: row.payload,
        createdAt: row.created_at,
      })),
      notifications: [],
      people: new Map(),
      organizationNames: new Map(),
    }).map((event) => event.paymentChange);
  }

  /** What balanceOf answers for the organization from the migrated rows, at two decimals. */
  async function amountDueOf(db: pg.Client): Promise<string> {
    const { rows } = await db.query<{ received: string | null; paid: string | null }>(
      `SELECT (SELECT sum(total_usd) FROM orders WHERE status = 'RECEIVED') AS received,
              (SELECT sum(amount_usd) FROM organization_payments WHERE voided_at IS NULL) AS paid`,
    );
    const { received, paid } = rows[0] ?? { received: null, paid: null };
    return balanceOf(
      new Prisma.Decimal(received ?? 0),
      new Prisma.Decimal(paid ?? 0),
    ).amountDue.toFixed(2);
  }

  async function migrateWithRate(
    rate: string,
    seed: (db: pg.Client) => Promise<void>,
  ): Promise<pg.Client> {
    const db = await freshDatabase();
    await db.query(`SET session_replication_role = replica`);
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('usd_rate', $1, now())`,
      [rateValue(rate)],
    );
    await seed(db);
    await db.query(`SET session_replication_role = DEFAULT`);
    await db.query(`ALTER TABLE orders
      DROP CONSTRAINT orders_organization_id_fkey,
      DROP CONSTRAINT orders_placed_by_user_id_fkey,
      DROP CONSTRAINT orders_price_list_version_id_fkey,
      DROP CONSTRAINT orders_driver_user_id_fkey`);
    await db.query(sqlOf(MIGRATION));
    return db;
  }

  const statusOf = async (db: pg.Client, id: string): Promise<unknown> =>
    (await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [id])).rows[0]
      ?.payment_status;
  const eventsOf = async (db: pg.Client): Promise<unknown[]> =>
    (
      await db.query<{ order_id: string; payload: unknown }>(
        `SELECT order_id, payload FROM order_events ORDER BY seq`,
      )
    ).rows;

  it('the two-order so’m case (15,000 + 15,000 at 12650, 30,000 paid) stays settled', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const db = await migrateWithRate('12650.0000', async (client) => {
      await insertOrder(client, a, 'IO-1', 'RECEIVED', '15000.00', 'PAID', '2026-10-03T00:00:00Z');
      await insertOrder(client, b, 'IO-2', 'RECEIVED', '15000.00', 'PAID', '2026-10-04T00:00:00Z');
      await insertPayment(client, randomUUID(), '30000.00');
    });
    expect(await statusOf(db, a)).toBe('PAID');
    expect(await statusOf(db, b)).toBe('PAID');
    expect(await eventsOf(db)).toEqual([]);
    expect(await customerTimelineOf(db, b)).toEqual([]);
    expect(await amountDueOf(db)).toBe('0.00');
  });

  it('a real difference keeps its event: a PAID order the payments do not cover turns UNPAID', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const db = await migrateWithRate('12000.0000', async (client) => {
      await insertOrder(client, a, 'IO-1', 'RECEIVED', '12000.00', 'PAID', '2026-10-03T00:00:00Z');
      await insertOrder(client, b, 'IO-2', 'RECEIVED', '12000.00', 'PAID', '2026-10-04T00:00:00Z');
      await insertPayment(client, randomUUID(), '12000.00');
    });
    expect(await statusOf(db, a)).toBe('PAID');
    expect(await statusOf(db, b)).toBe('UNPAID');
    expect(await eventsOf(db)).toEqual([
      {
        order_id: b,
        payload: { before: { paymentStatus: 'PAID' }, after: { paymentStatus: 'UNPAID' } },
      },
    ]);
    const { rows } = await db.query(
      `SELECT actor_user_id, actor_role FROM order_events WHERE order_id = $1`,
      [b],
    );
    expect(rows).toEqual([{ actor_user_id: null, actor_role: 'SYSTEM' }]);
    expect(await customerTimelineOf(db, b)).toEqual([{ from: 'PAID', to: 'UNPAID' }]);
    expect(await amountDueOf(db)).toBe('1.00');
  });

  it('a shortfall under half a cent settles an old unpaid order, with its event', async () => {
    const a = randomUUID();
    const db = await migrateWithRate('12000.0000', async (client) => {
      await insertOrder(
        client,
        a,
        'IO-1',
        'RECEIVED',
        '12000.00',
        'UNPAID',
        '2026-10-03T00:00:00Z',
      );
      await insertPayment(client, randomUUID(), '11990.00'); // 0.000833 short
    });
    expect(await statusOf(db, a)).toBe('PAID');
    expect(await eventsOf(db)).toEqual([
      {
        order_id: a,
        payload: { before: { paymentStatus: 'UNPAID' }, after: { paymentStatus: 'PAID' } },
      },
    ]);
    expect(await amountDueOf(db)).toBe('0.00');
  });

  it('an order worth almost nothing is not paid without money, nor ahead of an older one', async () => {
    const [alone, older, tiny] = [randomUUID(), randomUUID(), randomUUID()];
    const noMoney = await migrateWithRate('12650.0000', async (client) => {
      await insertOrder(
        client,
        alone,
        'IO-1',
        'RECEIVED',
        '1.00',
        'UNPAID',
        '2026-10-03T00:00:00Z',
      );
    });
    expect(await statusOf(noMoney, alone)).toBe('UNPAID');
    expect(await eventsOf(noMoney)).toEqual([]);

    const partly = await migrateWithRate('12650.0000', async (client) => {
      await insertOrder(
        client,
        older,
        'IO-1',
        'RECEIVED',
        '15000.00',
        'UNPAID',
        '2026-10-03T00:00:00Z',
      );
      await insertOrder(client, tiny, 'IO-2', 'RECEIVED', '1.00', 'UNPAID', '2026-10-04T00:00:00Z');
      await insertPayment(client, randomUUID(), '1000.00');
    });
    expect(await statusOf(partly, older)).toBe('UNPAID');
    expect(await statusOf(partly, tiny)).toBe('UNPAID');
    expect(await eventsOf(partly)).toEqual([]);
  });

  it('counts the USD total per line, like the api does after an edit', async () => {
    const id = randomUUID();
    const db = await migrateWithRate('12650.0000', async (client) => {
      await insertOrder(client, id, 'IO-1', 'SUBMITTED', '0.01', 'UNPAID');
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, product_code_snapshot, name_snapshot,
                                  unit_snapshot, quantity, unit_price, full_unit_price, line_total)
         VALUES ($1, $2, $3, 'P-2', 'Product 2', 'dona', 1, 0.02, 0.02, 0.02)`,
        [randomUUID(), id, randomUUID()],
      );
    });
    // 0.01 / 12650 is 0.000001 and 0.02 / 12650 is 0.000002; 0.03 / 12650 alone would be 0.000002.
    const { rows } = await db.query(`SELECT total_usd FROM orders WHERE id = $1`, [id]);
    expect(rows).toEqual([{ total_usd: '0.000003' }]);
  });

  it('uses the same half cent as the api', () => {
    expect(sqlOf(MIGRATION)).toContain(`settled_under CONSTANT NUMERIC := ${USD_SETTLED_UNDER}`);
  });

  describe('with existing rows and a rate setting', () => {
    let db: pg.Client;
    const submitted = randomUUID();
    const cancelled = randomUUID();
    const paidA = randomUUID();
    const paidB = randomUUID();
    const paidC = randomUUID();
    const payment = randomUUID();
    const voided = randomUUID();

    const orderRow = async (id: string): Promise<Record<string, unknown>> => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT status, payment_status, total_amount, usd_rate, total_usd, updated_at
         FROM orders WHERE id = $1`,
        [id],
      );
      const [row] = rows;
      if (row === undefined) throw new Error('The order vanished');
      return row;
    };

    beforeAll(async () => {
      db = await freshDatabase();
      await db.query(`SET session_replication_role = replica`);
      await db.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('usd_rate', $1, now())`,
        [rateValue('12000.0000')],
      );
      await insertOrder(db, submitted, 'IO-1', 'SUBMITTED', '3750.50', 'UNPAID');
      await insertOrder(db, cancelled, 'IO-2', 'CANCELLED', '6000.00', 'UNPAID');
      // Three orders fully paid in so'm by one exact payment: at two decimals the sum of the parts
      // would be a cent over the payment. At six decimals nothing changes for them.
      await insertOrder(db, paidA, 'IO-3', 'RECEIVED', '60.00', 'PAID', '2026-10-03T00:00:00Z');
      await insertOrder(db, paidB, 'IO-4', 'RECEIVED', '60.00', 'PAID', '2026-10-04T00:00:00Z');
      await insertOrder(db, paidC, 'IO-5', 'RECEIVED', '60.00', 'PAID', '2026-10-05T00:00:00Z');
      await insertPayment(db, payment, '180.00');
      await insertPayment(db, voided, '999.00', true);
      await db.query(`SET session_replication_role = DEFAULT`);
      // These bare rows have no parents. The rewrite makes every row "new in this transaction", so
      // the migration's UPDATE would re-check its foreign keys; real rows have valid parents.
      await db.query(`ALTER TABLE orders
        DROP CONSTRAINT orders_organization_id_fkey,
        DROP CONSTRAINT orders_placed_by_user_id_fkey,
        DROP CONSTRAINT orders_price_list_version_id_fkey,
        DROP CONSTRAINT orders_driver_user_id_fkey`);

      await db.query(sqlOf(MIGRATION));
    });

    it('converts every order with the current rate, whatever its status, and touches nothing else', async () => {
      expect(await orderRow(submitted)).toMatchObject({
        status: 'SUBMITTED',
        total_amount: '3750.50',
        usd_rate: '12000.0000',
        total_usd: '0.312542',
      });
      expect(await orderRow(cancelled)).toMatchObject({
        status: 'CANCELLED',
        total_amount: '6000.00',
        usd_rate: '12000.0000',
        total_usd: '0.500000',
      });
      expect((await orderRow(submitted)).updated_at).toEqual(new Date('2026-10-01T00:00:00Z'));
    });

    it('marks old payments as so’m at that rate, voided ones too', async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT id, amount, currency, rate, amount_usd, void_reason
         FROM organization_payments ORDER BY amount`,
      );
      expect(rows).toEqual([
        {
          id: payment,
          amount: '180.00',
          currency: 'UZS',
          rate: '12000.0000',
          amount_usd: '0.015000',
          void_reason: null,
        },
        {
          id: voided,
          amount: '999.00',
          currency: 'UZS',
          rate: '12000.0000',
          amount_usd: '0.083250',
          void_reason: 'duplicate',
        },
      ]);
    });

    it('leaves orders settled exactly in so’m PAID, with no event, nothing on the customer timeline and nothing due', async () => {
      for (const id of [paidA, paidB, paidC]) {
        expect((await orderRow(id)).payment_status).toBe('PAID');
        expect(await customerTimelineOf(db, id)).toEqual([]);
      }
      const { rows } = await db.query(`SELECT 1 FROM order_events`);
      expect(rows).toEqual([]);
      expect(await amountDueOf(db)).toBe('0.00');
    });

    it('records every backfilled payment and order in the audit log, actor system', async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT actor_user_id, entity_type, entity_id, action, diff
         FROM audit_log WHERE entity_id = ANY($1) ORDER BY entity_id`,
        [[payment, voided, submitted]],
      );
      const byId = new Map(rows.map((row) => [row.entity_id, row]));
      expect(rows).toHaveLength(3);
      expect(byId.get(payment)).toEqual({
        actor_user_id: null,
        entity_type: 'ORGANIZATION_PAYMENT',
        entity_id: payment,
        action: 'MIGRATION_USD_PAYMENT_BACKFILLED',
        diff: {
          currency: { from: null, to: 'UZS' },
          rate: { from: null, to: '12000.0000' },
          amountUsd: { from: null, to: '0.015000' },
        },
      });
      expect(byId.get(voided)).toMatchObject({
        diff: { amountUsd: { from: null, to: '0.083250' } },
      });
      expect(byId.get(submitted)).toEqual({
        actor_user_id: null,
        entity_type: 'ORDER',
        entity_id: submitted,
        action: 'MIGRATION_USD_ORDER_BACKFILLED',
        diff: {
          usdRate: { from: null, to: '12000.0000' },
          totalUsd: { from: null, to: '0.312542' },
        },
      });
      const { rows: counted } = await db.query<{ action: string; count: string }>(
        `SELECT action, count(*) FROM audit_log GROUP BY action ORDER BY action`,
      );
      expect(counted).toEqual([
        { action: 'MIGRATION_USD_ORDER_BACKFILLED', count: '5' },
        { action: 'MIGRATION_USD_PAYMENT_BACKFILLED', count: '2' },
      ]);
    });

    it('old lines have no USD snapshot and every snapshot is immutable from now on', async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT full_unit_price_usd, deferred_unit_price_usd FROM order_items`,
      );
      expect(new Set(rows.map((row) => row.full_unit_price_usd))).toEqual(new Set([null]));
      expect(new Set(rows.map((row) => row.deferred_unit_price_usd))).toEqual(new Set([null]));
      await expect(
        db.query(`UPDATE order_items SET full_unit_price_usd = 1 WHERE order_id = $1`, [submitted]),
      ).rejects.toThrow(/price snapshots of an order line are immutable/);
    });

    it('freezes the rate and guards the USD figures from now on', async () => {
      await expect(
        db.query(`UPDATE orders SET usd_rate = 13000 WHERE id = $1`, [submitted]),
      ).rejects.toThrow(/frozen at submit/);
      await expect(
        db.query(`UPDATE orders SET total_usd = 5 WHERE id = $1`, [submitted]),
      ).rejects.toThrow(/orders_total_usd_sane/);
      await expect(
        db.query(`UPDATE organization_payments SET amount_usd = 5 WHERE id = $1`, [payment]),
      ).rejects.toThrow(/organization_payments_usd_value_exact/);
      await expect(
        db.query(`UPDATE organization_payments SET currency = 'EUR' WHERE id = $1`, [payment]),
      ).rejects.toThrow(/organization_payments_currency_known/);
    });

    it('keeps the old guards on the rewritten rows', async () => {
      await expect(
        db.query(`UPDATE organization_payments SET comment = 'later' WHERE id = $1`, [voided]),
      ).rejects.toThrow(/a voided payment never changes/);
      await expect(
        db.query(`UPDATE orders SET status = 'SUBMITTED' WHERE id = $1`, [cancelled]),
      ).rejects.toThrow();
    });
  });

  it('succeeds on empty tables without a rate setting', async () => {
    const db = await freshDatabase();
    await db.query(sqlOf(MIGRATION));
    const { rows } = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name = 'usd_rate'`,
    );
    expect(rows).toEqual([{ is_nullable: 'NO' }]);
  });

  it('fails with a clear message on existing rows without a rate, and changes nothing', async () => {
    const db = await freshDatabase();
    await db.query(`SET session_replication_role = replica`);
    await insertPayment(db, randomUUID(), '100.00');
    await db.query(`SET session_replication_role = DEFAULT`);
    await expect(db.query(sqlOf(MIGRATION))).rejects.toThrow(
      /1 payments exist but the usd_rate setting is missing or invalid/,
    );
    // Prisma marks the failed migration (P3009): only this command clears that, nothing else does.
    await expect(db.query(sqlOf(MIGRATION))).rejects.toThrow(
      /prisma migrate resolve --rolled-back 20261114090000_usd_organization_debt/,
    );
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'organization_payments' AND column_name = 'amount_usd'`,
    );
    expect(rows).toEqual([]);
  });

  it('treats a stored rate that is not a positive decimal like no rate at all', async () => {
    for (const bad of ['0', 'abc', '-5']) {
      const db = await freshDatabase();
      await db.query(`SET session_replication_role = replica`);
      await db.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('usd_rate', $1, now())`,
        [rateValue(bad)],
      );
      await insertOrder(db, randomUUID(), 'IO-1', 'SUBMITTED', '100.00', 'UNPAID');
      await db.query(`SET session_replication_role = DEFAULT`);
      await expect(db.query(sqlOf(MIGRATION)), bad).rejects.toThrow(/1 orders and 0 payments/);
    }
  }, 120_000);
});
