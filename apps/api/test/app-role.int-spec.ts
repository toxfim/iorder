import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPrisma, resetCatalogPricingAudit } from './support/test-db.js';
import { getRestrictedRoleUrl } from './support/test-env.js';

// The triggers stop application mistakes. Against a table owner or superuser they are not a
// security boundary (DISABLE TRIGGER, session_replication_role). The boundary is the role the
// application connects with: not an owner, DML only. This test proves what such a role cannot
// do. Production must use a role of this shape (separate from the migration role).
describe('restricted application role (real PostgreSQL)', () => {
  const owner = createTestPrisma();
  const app = new pg.Client({ connectionString: getRestrictedRoleUrl() });
  const auditId = randomUUID();

  beforeAll(async () => {
    await owner.onModuleInit();
    await resetCatalogPricingAudit(owner);
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
    await owner.onModuleDestroy();
  });

  const denied = /permission denied|must be owner|superuser|not allowed/i;

  // The exact table privileges of the production role (apps/api/db/app-role-grants.sql, applied
  // by global setup). A table missing from this map fails the test, so a new table gets its
  // grants on purpose.
  const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  const EXPECTED: Record<string, string> = {
    // UPDATE is granted on last_used_at and revoked_at only.
    api_tokens: 'SELECT INSERT',
    app_settings: 'SELECT INSERT UPDATE',
    audit_log: 'SELECT INSERT',
    // Brands are added, never renamed or removed by the application (migration brands).
    brands: 'SELECT INSERT',
    cart_items: 'SELECT INSERT UPDATE DELETE',
    carts: 'SELECT INSERT UPDATE',
    customer_goods_discovery_acks: 'SELECT INSERT',
    notification_outbox: 'SELECT INSERT',
    order_events: 'SELECT INSERT',
    order_items: 'SELECT INSERT UPDATE DELETE',
    order_allocations: 'SELECT INSERT',
    order_units: 'SELECT INSERT',
    orders: 'SELECT INSERT UPDATE',
    organization_invites: 'SELECT INSERT UPDATE',
    organization_members: 'SELECT INSERT UPDATE',
    // Payments are voided, never deleted (and a trigger keeps the origin and a void fixed).
    organization_payments: 'SELECT INSERT UPDATE',
    organizations: 'SELECT INSERT UPDATE',
    price_list_items: 'SELECT INSERT UPDATE DELETE',
    price_list_version_rates: 'SELECT INSERT',
    price_list_versions: 'SELECT INSERT UPDATE DELETE',
    price_reference: 'SELECT INSERT UPDATE',
    product_categories: 'SELECT INSERT UPDATE',
    // UPDATE is granted on is_primary and the removal columns only.
    product_images: 'SELECT INSERT',
    // Pairs are proposed and decided, never deleted (and a trigger keeps the pair fixed).
    product_successions: 'SELECT INSERT UPDATE',
    product_translations: 'SELECT INSERT UPDATE',
    sheet_sync_runs: 'SELECT INSERT DELETE',
    products: 'SELECT INSERT UPDATE',
    staff_credentials: 'SELECT INSERT UPDATE',
    // UPDATE is granted on used_at only (see the column test below); DELETE only a day after use.
    staff_handoff_codes: 'SELECT INSERT DELETE',
    staff_sessions: 'SELECT INSERT',
    stock_cache: 'SELECT INSERT UPDATE',
    supply_parties: 'SELECT INSERT UPDATE DELETE',
    supply_removal_requests: 'SELECT INSERT UPDATE',
    // UPDATE is granted on used_at only (see the column test below).
    telegram_link_tokens: 'SELECT INSERT',
    // UPDATE is granted on the void columns only.
    unit_codes: 'SELECT INSERT',
    user_roles: 'SELECT INSERT UPDATE DELETE',
    users: 'SELECT INSERT UPDATE',
  };

  it('has exactly the privileges of the production grants file, never TRUNCATE or TRIGGER', async () => {
    // The tables come from this branch's migrations, not from the database: the shared test
    // database may hold tables of other branches.
    const migrations = new URL('../prisma/migrations/', import.meta.url);
    const created = readdirSync(migrations).flatMap((dir) => {
      const file = new URL(`${dir}/migration.sql`, migrations);
      if (!existsSync(file)) return [];
      return [...readFileSync(file, 'utf8').matchAll(/CREATE TABLE "([a-z_]+)"/g)].map(
        (m) => m[1] ?? '',
      );
    });
    const tables = [...new Set(created)].sort();
    expect(tables).toEqual(Object.keys(EXPECTED).sort());
    for (const table of tables) {
      const granted: string[] = [];
      for (const privilege of PRIVILEGES) {
        const { rows } = await app.query<{ ok: boolean }>(
          `SELECT has_table_privilege(current_user, $1, $2) AS ok`,
          [`public.${table}`, privilege],
        );
        if (rows[0]?.ok) granted.push(privilege);
      }
      expect(granted.join(' '), table).toBe(EXPECTED[table]);
    }
  });

  it('may only mark a bot connect link used, once, and never delete one', async () => {
    const { rows: columns } = await app.query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a
       WHERE a.attrelid = 'public.telegram_link_tokens'::regclass AND a.attnum > 0
         AND NOT a.attisdropped
         AND has_column_privilege(current_user, 'public.telegram_link_tokens', a.attname, 'UPDATE')
       ORDER BY 1`,
    );
    expect(columns.map((r) => r.column_name)).toEqual(['used_at']);

    const user = await owner.user.create({
      data: { fullName: 'Link token holder', telegramUserId: BigInt(Date.now()) * 10n },
    });
    const tokenId = randomUUID();
    await app.query(
      `INSERT INTO telegram_link_tokens (id, user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + interval '10 minutes')`,
      [tokenId, user.id, randomUUID()],
    );
    await app.query(`UPDATE telegram_link_tokens SET used_at = now() WHERE id = $1`, [tokenId]);
    await expect(
      app.query(`UPDATE telegram_link_tokens SET used_at = NULL WHERE id = $1`, [tokenId]),
    ).rejects.toThrow(/already used/);
    await expect(
      app.query(`DELETE FROM telegram_link_tokens WHERE id = $1`, [tokenId]),
    ).rejects.toThrow(denied);
  });

  it('may only mark a customer site handoff code used, once, and never delete or rewrite one', async () => {
    const { rows: columns } = await app.query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a
       WHERE a.attrelid = 'public.staff_handoff_codes'::regclass AND a.attnum > 0
         AND NOT a.attisdropped
         AND has_column_privilege(current_user, 'public.staff_handoff_codes', a.attname, 'UPDATE')
       ORDER BY 1`,
    );
    expect(columns.map((r) => r.column_name)).toEqual(['used_at']);

    const user = await owner.user.create({
      data: { fullName: 'Handoff code holder', telegramUserId: BigInt(Date.now()) * 10n + 2n },
    });
    const sessionId = randomUUID();
    await app.query(
      `INSERT INTO staff_sessions (id, user_id, token_hash, method, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, 'PASSWORD', now(), now(), now() + interval '1 day')`,
      [sessionId, user.id, randomUUID().replaceAll('-', '').repeat(2)],
    );
    const codeId = randomUUID();
    await app.query(
      `INSERT INTO staff_handoff_codes (id, user_id, session_id, code_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now() + interval '1 minute')`,
      [codeId, user.id, sessionId, randomUUID()],
    );
    // The owner role is bound by the trigger too: who the code belongs to cannot be rewritten.
    await expect(
      owner.$executeRaw`UPDATE staff_handoff_codes SET expires_at = now() + interval '1 day' WHERE id = ${codeId}::uuid`,
    ).rejects.toThrow(/only used_at/);
    await app.query(`UPDATE staff_handoff_codes SET used_at = now() WHERE id = $1`, [codeId]);
    await expect(
      app.query(`UPDATE staff_handoff_codes SET used_at = NULL WHERE id = $1`, [codeId]),
    ).rejects.toThrow(/already used/);
    // Just used: not yet removable, by nobody. A day later (the clock is the database's): yes.
    await expect(
      app.query(`DELETE FROM staff_handoff_codes WHERE id = $1`, [codeId]),
    ).rejects.toThrow(/only a day after/);
    await expect(
      owner.$executeRaw`DELETE FROM staff_handoff_codes WHERE id = ${codeId}::uuid`,
    ).rejects.toThrow(/only a day after/);
    const oldId = randomUUID();
    await app.query(
      `INSERT INTO staff_handoff_codes (id, user_id, session_id, code_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, now() - interval '2 days', now() - interval '2 days' + interval '1 minute')`,
      [oldId, user.id, sessionId, randomUUID()],
    );
    const { rowCount } = await app.query(`DELETE FROM staff_handoff_codes WHERE id = $1`, [oldId]);
    expect(rowCount).toBe(1);
  });

  it('keeps a staff viewer`s session a viewer session and their cart one per person [C, 2026-11-09]', async () => {
    const user = await owner.user.create({
      data: { fullName: 'Staff viewer', telegramUserId: BigInt(Date.now()) * 10n + 1n },
    });
    const sessionId = randomUUID();
    await app.query(
      `INSERT INTO staff_sessions
         (id, user_id, token_hash, method, staff_viewer, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, 'PASSWORD', true, now(), now(), now() + interval '1 hour')`,
      [sessionId, user.id, randomUUID().replaceAll('-', '').repeat(2)],
    );
    // The application role cannot turn a viewer session into a staff session: the column is not
    // among the ones it may update, and the trigger refuses the change even for the owner.
    await expect(
      app.query(`UPDATE staff_sessions SET staff_viewer = false WHERE id = $1`, [sessionId]),
    ).rejects.toThrow(denied);
    await expect(
      owner.$executeRaw`UPDATE staff_sessions SET staff_viewer = false WHERE id = ${sessionId}::uuid`,
    ).rejects.toThrow(/only last_seen_at and revoked_at/);
    await app.query(`UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);

    // The personal cart (no organization): the upsert the repository runs works with the role's
    // privileges, and a second cart without an organization for the same person is impossible.
    const upsert = (id: string) =>
      app.query<{ id: string }>(
        `INSERT INTO carts (id, user_id, organization_id, created_at, updated_at)
         VALUES ($1, $2, NULL, now(), now())
         ON CONFLICT (user_id) WHERE organization_id IS NULL
         DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING id`,
        [id, user.id],
      );
    const first = (await upsert(randomUUID())).rows[0]?.id;
    expect((await upsert(randomUUID())).rows[0]?.id).toBe(first);
    await expect(
      app.query(
        `INSERT INTO carts (id, user_id, organization_id, created_at, updated_at)
         VALUES ($1, $2, NULL, now(), now())`,
        [randomUUID(), user.id],
      ),
    ).rejects.toThrow(/carts_user_id_without_organization_key/);
  });

  it('may update only the delivery bookkeeping columns of the outbox, and never call setval', async () => {
    const { rows } = await app.query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a
       WHERE a.attrelid = 'public.notification_outbox'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege(current_user, 'public.notification_outbox', a.attname, 'UPDATE')
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'attempts',
      'delivered_chat_ids',
      'last_error_code',
      'next_attempt_at',
      'sent_at',
      'status',
    ]);
    const { rows: seq } = await app.query<{ usage: boolean; sel: boolean; upd: boolean }>(
      `SELECT has_sequence_privilege(current_user, 'public.order_number_seq', 'USAGE') AS usage,
              has_sequence_privilege(current_user, 'public.order_number_seq', 'SELECT') AS sel,
              has_sequence_privilege(current_user, 'public.order_number_seq', 'UPDATE') AS upd`,
    );
    expect(seq[0]).toEqual({ usage: true, sel: true, upd: false });
  });

  it('is not a superuser and owns nothing', async () => {
    const { rows } = await app.query<{ rolsuper: boolean; owned: string }>(`
      SELECT r.rolsuper,
             (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace)::text AS owned
      FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toEqual({ rolsuper: false, owned: '0' });
  });

  it('can do ordinary DML and append to the audit log', async () => {
    const productId = randomUUID();
    await app.query(
      `INSERT INTO products (id, product_code, unit, updated_at) VALUES ($1, 'ROLE-1', 'box', now())`,
      [productId],
    );
    await app.query(`UPDATE products SET unit = 'kg' WHERE id = $1`, [productId]);
    await app.query(
      `INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, diff, created_at)
       VALUES ($1, 'u1', 'PRODUCT', $2, 'TEST', '{}'::jsonb, now())`,
      [auditId, productId],
    );
    const { rows } = await app.query('SELECT 1 FROM audit_log WHERE id = $1', [auditId]);
    expect(rows).toHaveLength(1);
  });

  it.each([
    [
      'DISABLE TRIGGER on audit_log',
      'ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete',
    ],
    ['DISABLE TRIGGER ALL on price_list_items', 'ALTER TABLE price_list_items DISABLE TRIGGER ALL'],
    ['DROP TRIGGER', 'DROP TRIGGER price_list_items_guard ON price_list_items'],
    ['TRUNCATE price_list_items', 'TRUNCATE price_list_items'],
    ['TRUNCATE products CASCADE', 'TRUNCATE products CASCADE'],
    ['TRUNCATE audit_log', 'TRUNCATE audit_log'],
    ['SET session_replication_role = replica', `SET session_replication_role = replica`],
    ['DELETE on audit_log', 'DELETE FROM audit_log'],
    ['UPDATE on audit_log', `UPDATE audit_log SET action = 'TAMPERED'`],
    ['DROP TABLE audit_log', 'DROP TABLE audit_log'],
    // Orders and their history (hard rules 2 and 3), proven against the production grants file.
    ['DELETE on orders', 'DELETE FROM orders'],
    ['TRUNCATE orders', 'TRUNCATE orders'],
    ['TRUNCATE orders CASCADE', 'TRUNCATE orders CASCADE'],
    [
      'DISABLE TRIGGER on orders (status guard)',
      'ALTER TABLE orders DISABLE TRIGGER orders_status_move_guard_rows',
    ],
    ['DISABLE TRIGGER ALL on orders', 'ALTER TABLE orders DISABLE TRIGGER ALL'],
    [
      'DISABLE TRIGGER on order_events',
      'ALTER TABLE order_events DISABLE TRIGGER order_events_no_update_delete',
    ],
    ['UPDATE on order_events', `UPDATE order_events SET comment = 'tampered'`],
    ['DELETE on order_events', 'DELETE FROM order_events'],
    ['TRUNCATE order_events', 'TRUNCATE order_events'],
    ['UPDATE the payload of an outbox row', `UPDATE notification_outbox SET payload = '{}'::jsonb`],
    ['DELETE on notification_outbox', 'DELETE FROM notification_outbox'],
    ['UPDATE on price_list_version_rates', `UPDATE price_list_version_rates SET source = 'MANUAL'`],
    ['DELETE on price_list_version_rates', 'DELETE FROM price_list_version_rates'],
    ['jump a sequence with setval', `SELECT setval('order_number_seq', 99999999)`],
    ['DROP TABLE orders', 'DROP TABLE orders'],
    ['CREATE TABLE', 'CREATE TABLE rogue (id int)'],
  ])('cannot %s', async (_name, statement) => {
    await expect(app.query(statement)).rejects.toThrow(denied);
  });

  it('prices a product with a NULL legacy unit (pieces only: the unit guard trigger is gone)', async () => {
    const productId = randomUUID();
    const versionId = randomUUID();
    await app.query(
      `INSERT INTO products (id, product_code, unit, updated_at) VALUES ($1, 'ROLE-NOUNIT', NULL, now())`,
      [productId],
    );
    await app.query(
      `INSERT INTO price_list_versions (id, status, source, created_at)
       VALUES ($1, 'DRAFT', 'MANUAL', now())`,
      [versionId],
    );
    await app.query(
      `INSERT INTO price_list_items (id, version_id, product_id, base_price, currency)
       VALUES ($1, $2, $3, 5.00, 'UZS')`,
      [randomUUID(), versionId, productId],
    );
  });

  it('cannot write anonymous history: NULL actor only for SHEET_SYNC_* actions', async () => {
    const insert = (action: string) =>
      app.query(
        `INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, diff, created_at)
         VALUES ($1, NULL, 'T', 'e', $2, '{}'::jsonb, now())`,
        [randomUUID(), action],
      );
    await expect(insert('PRODUCT_UPDATED')).rejects.toThrow(/audit_log_actor_required/);
    await expect(insert('SHEET_SYNC_CREATED')).resolves.toBeDefined();
    await expect(insert('RATE_REFRESH_UPDATED')).resolves.toBeDefined();
  });

  it('can add sync runs and prune old ones, but cannot change or empty the history', async () => {
    const id = randomUUID();
    await app.query(
      `INSERT INTO sheet_sync_runs (id, started_at, finished_at, status, trigger, counts,
         rejected_rows, skipped_suppliers, created_products, pending_removal_requests, cost_mismatches)
       VALUES ($1, now(), now(), 'OK', 'MANUAL', '{}', '[]', '[]', '[]', 0, '[]')`,
      [id],
    );
    await expect(
      app.query('SELECT 1 FROM sheet_sync_runs WHERE id = $1', [id]),
    ).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(app.query(`UPDATE sheet_sync_runs SET status = 'FAILED'`)).rejects.toThrow(denied);
    await expect(app.query('TRUNCATE sheet_sync_runs')).rejects.toThrow(denied);
    await app.query('DELETE FROM sheet_sync_runs WHERE id = $1', [id]);
  });

  it('left the audit row untouched', async () => {
    const { rows } = await app.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE id = $1',
      [auditId],
    );
    expect(rows[0]?.action).toBe('TEST');
  });
});
