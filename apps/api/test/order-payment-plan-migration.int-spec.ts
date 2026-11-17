import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from './support/test-env.js';

const MIGRATION = '20261113090000_order_payment_plan';
const MIGRATIONS_DIR = new URL('../prisma/migrations/', import.meta.url);

const sqlOf = (name: string): string =>
  readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS_DIR), 'utf8');

// A separate database, because the shared one is already past this migration: every migration
// before it, then rows as production has them, then the migration itself.
describe(`migration ${MIGRATION} on pre-existing rows (real PostgreSQL)`, () => {
  const databaseName = `iorder_test_migration_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: getTestDatabaseUrl() });
  let db: pg.Client;

  const organizationId = randomUUID();
  const userId = randomUUID();
  const versionId = randomUUID();
  const productId = randomUUID();
  const submittedOrder = randomUUID();
  const approvedOrder = randomUUID();
  const submittedItem = randomUUID();
  const approvedItem = randomUUID();

  const insertOrder = (id: string, status: string, number: string): Promise<unknown> =>
    db.query(
      `INSERT INTO orders (id, order_number, organization_id, placed_by_user_id,
                           price_list_version_id, status, total_amount, idempotency_key,
                           submitted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 3000.50, $2, now(), now())`,
      [id, number, organizationId, userId, versionId, status],
    );
  const insertItem = (id: string, orderId: string): Promise<unknown> =>
    db.query(
      `INSERT INTO order_items (id, order_id, product_id, product_code_snapshot, name_snapshot,
                                unit_snapshot, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'P-1', 'Product', 'dona', 2, 1500.25, 3000.50)`,
      [id, orderId, productId],
    );
  const itemRow = async (id: string): Promise<Record<string, unknown>> => {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM order_items WHERE id = $1',
      [id],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('The line vanished');
    return row;
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(getTestDatabaseUrl());
    url.pathname = `/${databaseName}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();

    const earlier = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
      .map((entry) => entry.name)
      .sort();
    for (const name of earlier) await db.query(sqlOf(name));

    // Replica mode skips triggers and foreign keys: an order past SUBMITTED exists in production
    // only through the workflow, which these bare rows do not need to replay. CHECKs still run.
    await db.query(`SET session_replication_role = replica`);
    await insertOrder(submittedOrder, 'SUBMITTED', 'IO-OLD-1');
    await insertOrder(approvedOrder, 'MANAGER_APPROVED', 'IO-OLD-2');
    await insertItem(submittedItem, submittedOrder);
    await insertItem(approvedItem, approvedOrder);
    await db.query(`SET session_replication_role = DEFAULT`);

    await db.query(sqlOf(MIGRATION));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
    // DROP DATABASE waits for a checkpoint, which took over a minute on a busy disk.
  }, 300_000);

  it('prices every old line at the sale price with no deferred snapshot', async () => {
    for (const id of [submittedItem, approvedItem]) {
      expect(await itemRow(id)).toMatchObject({
        full_unit_price: '1500.25',
        deferred_unit_price: null,
        unit_price: '1500.25',
        quantity: '2.000',
        line_total: '3000.50',
      });
    }
  });

  it('makes every old order FULL and leaves its status and total alone', async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT id, status, payment_plan, total_amount FROM orders ORDER BY order_number',
    );
    expect(rows).toEqual([
      {
        id: submittedOrder,
        status: 'SUBMITTED',
        payment_plan: 'FULL',
        total_amount: '3000.50',
      },
      {
        id: approvedOrder,
        status: 'MANAGER_APPROVED',
        payment_plan: 'FULL',
        total_amount: '3000.50',
      },
    ]);
  });

  it('freezes the plan of the old order past SUBMITTED', async () => {
    await expect(
      db.query(
        `UPDATE orders SET payment_plan = 'DEFERRED', row_version = row_version + 1 WHERE id = $1`,
        [approvedOrder],
      ),
    ).rejects.toThrow(/immutable once the order left SUBMITTED/);
  });

  it('applies the guards to old lines too', async () => {
    await expect(
      db.query(`UPDATE order_items SET full_unit_price = 1 WHERE id = $1`, [submittedItem]),
    ).rejects.toThrow(/price snapshots of an order line are immutable/);
    await expect(
      db.query(`UPDATE order_items SET unit_price = 1, line_total = 2 WHERE id = $1`, [
        submittedItem,
      ]),
    ).rejects.toThrow(/order_items_unit_price_is_a_snapshot/);
  });

  it('still lets a quantity of an old SUBMITTED order change', async () => {
    // Together with the total, which a deferred trigger compares to the lines at commit.
    await db.query('BEGIN');
    await db.query(`UPDATE order_items SET quantity = 3, line_total = 4500.75 WHERE id = $1`, [
      submittedItem,
    ]);
    await db.query(
      `UPDATE orders SET total_amount = 4500.75, row_version = row_version + 1 WHERE id = $1`,
      [submittedOrder],
    );
    await db.query('COMMIT');
    expect(await itemRow(submittedItem)).toMatchObject({
      quantity: '3.000',
      full_unit_price: '1500.25',
    });
  });
});
