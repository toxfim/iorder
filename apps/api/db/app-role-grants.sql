-- iOrder.uz: the exact privileges of the PRODUCTION APPLICATION role.
--
-- Single source of truth: the integration tests apply THIS file to the restricted test role
-- (apps/api/test/support/global-setup.ts), and production applies it to the real role. See
-- docs/private/architecture/production-db-roles.md.
--
-- Run it as the table owner / migrator (never as the application role), AFTER the migrations:
--
--     psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -v app_role=iorder_app \
--          -f apps/api/db/app-role-grants.sql
--
-- `:"app_role"` is a psql variable substituted as a quoted identifier. The role itself (LOGIN,
-- password, NOSUPERUSER) and `GRANT CONNECT ON DATABASE ... TO` are created by the DBA, outside
-- this file. Idempotent: every statement can be re-run; it first revokes everything, then grants
-- exactly the list below, so a table added by a later migration has NO privilege until it is added
-- here on purpose. Re-run it after every migration that adds a table or a sequence.
--
-- Why the app role is safe even though triggers guard the data: a table owner can DISABLE TRIGGER
-- and a superuser can set session_replication_role. This role owns nothing and has no TRIGGER,
-- TRUNCATE, REFERENCES or DDL privilege, so the triggers cannot be switched off from the app.
--
-- THE JOBS WORKER (pg-boss) also needs privileges on the separate `pgboss` schema. They are NOT in
-- this file: that schema does not exist until `jobs:migrate` has created it (as the migrator), and
-- these statements only touch `public`. Run `apps/api/db/pgboss-grants.sql` for the same role
-- after `jobs:migrate`. Nothing in this file grants anything on `pgboss`.

GRANT USAGE ON SCHEMA public TO :"app_role";

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"app_role";

-- Ordinary tables the application reads and writes. NO DELETE: these rows are history or
-- configuration that is never removed by the application (no TRUNCATE or TRIGGER anywhere).
GRANT SELECT, INSERT, UPDATE ON TABLE
    app_settings,
    products,
    product_translations,
    price_list_versions,
    price_reference,
    stock_cache,
    supply_removal_requests,
    users,
    organizations,
    organization_invites,
    organization_members,
    carts,
    staff_credentials,
    product_categories
    TO :"app_role";

-- Orders: edited (status, totals, accounting facts) but NEVER deleted (history; also a trigger).
GRANT SELECT, INSERT, UPDATE ON TABLE orders TO :"app_role";

-- Rows the application does remove: a draft price list's lines (and a discarded draft, which
-- cascades inside the database), a person's staff role, cart lines, order lines while the order is
-- still SUBMITTED (a trigger refuses it later), and a supply's party when the manager replaces a
-- party's members (its history stays in audit_log).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    price_list_items,
    user_roles,
    cart_items,
    order_items,
    supply_parties
    TO :"app_role";
GRANT DELETE ON TABLE price_list_versions TO :"app_role";

-- Written once, then read: SELECT and INSERT only (a discarded draft cascades inside the
-- database). Append-only history: audit_log, order_events. The application can never change or
-- remove a row, and triggers refuse it for the owner as well.
GRANT SELECT, INSERT ON TABLE
    price_list_version_rates,
    audit_log,
    order_events
    TO :"app_role";

-- Unit tracking (migration unit_code_tracking): one row per shipped piece, written once; the
-- My Products introduction acknowledgement, written once. Scanned codes are added and may only be
-- VOIDED (column-level UPDATE; a trigger lets the void columns be set once and nothing else).
GRANT SELECT, INSERT ON TABLE
    order_units,
    customer_goods_discovery_acks
    TO :"app_role";
GRANT SELECT, INSERT ON TABLE unit_codes TO :"app_role";
GRANT UPDATE (voided_at, voided_by, void_reason) ON TABLE unit_codes TO :"app_role";

-- Stock holds (migration order_allocations): added, then ended or voided once; never deleted (a
-- trigger keeps every other column fixed).
GRANT SELECT, INSERT ON TABLE order_allocations TO :"app_role";
GRANT UPDATE (hold_ended_at, voided_at, voided_by) ON TABLE order_allocations TO :"app_role";

-- Organization payments (migration organization_payments): recorded, corrected or voided by the
-- application, never deleted (a trigger also keeps the origin fixed and a void final).
GRANT SELECT, INSERT, UPDATE ON TABLE organization_payments TO :"app_role";

-- Brands (migration brands): added by the manager or the admin, never renamed or removed by the
-- application. products.brand_id is covered by the products grant above.
GRANT SELECT, INSERT ON TABLE brands TO :"app_role";

-- Newer-model pairs (migration product_successions): proposed by the generator, confirmed or
-- rejected by the manager or the admin, never deleted (a trigger also keeps the pair fixed).
GRANT SELECT, INSERT, UPDATE ON TABLE product_successions TO :"app_role";

-- Sync run history: rows are added and the oldest pruned, never changed (no UPDATE, no TRUNCATE).
GRANT SELECT, INSERT, DELETE ON TABLE sheet_sync_runs TO :"app_role";

-- The outbox: the application adds rows; the sender may update ONLY its delivery bookkeeping.
-- A column-level UPDATE grant, so even a bug cannot rewrite a recipient or a payload.
GRANT SELECT, INSERT ON TABLE notification_outbox TO :"app_role";
-- The delivery bookkeeping columns: status, attempts, sent_at and (migration telegram_bot_support)
-- next_attempt_at, last_error_code, delivered_chat_ids.
GRANT UPDATE (status, attempts, sent_at, next_attempt_at, last_error_code, delivered_chat_ids)
    ON TABLE notification_outbox TO :"app_role";

-- Website sessions: rows are added and never deleted; the application may update ONLY the two
-- bookkeeping columns (a trigger additionally keeps a revoked session revoked).
GRANT SELECT, INSERT ON TABLE staff_sessions TO :"app_role";
GRANT UPDATE (last_seen_at, revoked_at) ON TABLE staff_sessions TO :"app_role";

-- Bot connect links (migration staff_bot_notifications): added, then marked used once; never
-- deleted, and a trigger keeps a used token used.
GRANT SELECT, INSERT ON TABLE telegram_link_tokens TO :"app_role";
GRANT UPDATE (used_at) ON TABLE telegram_link_tokens TO :"app_role";

-- Customer site handoff codes (migration staff_handoff_codes): added, then marked used once; a
-- trigger keeps a used code used and every other column fixed.
GRANT SELECT, INSERT, DELETE ON TABLE staff_handoff_codes TO :"app_role";
GRANT UPDATE (used_at) ON TABLE staff_handoff_codes TO :"app_role";
-- DELETE: the trigger (migration staff_session_source) allows it only a day after use or expiry.

-- API tokens (migration api_tokens): issued by the CLI, never deleted; the application may update
-- ONLY the bookkeeping columns (a trigger also keeps a revoked token revoked).
GRANT SELECT, INSERT ON TABLE api_tokens TO :"app_role";
GRANT UPDATE (last_used_at, revoked_at) ON TABLE api_tokens TO :"app_role";

-- Product photos (migration product_images): added, switched primary, or marked removed; never
-- deleted (a trigger refuses it and keeps every other column fixed). product_id may change only
-- when a generated-code product is merged (migration manual_products; the trigger allows exactly
-- the move onto the product it was merged into).
GRANT SELECT, INSERT ON TABLE product_images TO :"app_role";
GRANT UPDATE (is_primary, removed_at, removed_by, product_id) ON TABLE product_images TO :"app_role";

-- Sequences (order numbers, event ordering, generated product codes
-- product_generated_code_seq): nextval needs USAGE; reading the value needs SELECT.
-- No UPDATE: the application cannot reset or jump a sequence with setval.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
