-- Owner rule: the organization's debt is calculated with the rate at the time the order was placed,
-- in USD. Each order keeps its rate from submit and its USD total; a payment keeps its currency, the
-- rate of a so'm payment and its USD value. Debt = USD total of RECEIVED orders - USD value of live
-- payments. Backfill [P]: existing rows take the current `usd_rate` setting, the only rate known.
-- USD is kept at six decimals and a difference under half a cent is settled [P]: so'm amounts
-- converted one by one must not leave a settled order a cent short.

ALTER TABLE "orders"
    ADD COLUMN "usd_rate" DECIMAL(18,4),
    ADD COLUMN "total_usd" DECIMAL(18,6);

ALTER TABLE "organization_payments"
    ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'UZS',
    ADD COLUMN "rate" DECIMAL(18,4),
    ADD COLUMN "amount_usd" DECIMAL(18,6);
ALTER TABLE "organization_payments" ALTER COLUMN "currency" DROP DEFAULT;

-- The USD prices of a line, so a USD list's order counts exactly what it was sold for. Existing lines
-- stay NULL: their so'm line total at the frozen rate is their USD value.
ALTER TABLE "order_items"
    ADD COLUMN "full_unit_price_usd" DECIMAL(18,2),
    ADD COLUMN "deferred_unit_price_usd" DECIMAL(18,2),
    ADD CONSTRAINT "order_items_full_unit_price_usd_positive"
        CHECK ("full_unit_price_usd" IS NULL OR "full_unit_price_usd" > 0),
    ADD CONSTRAINT "order_items_deferred_unit_price_usd_positive"
        CHECK ("deferred_unit_price_usd" IS NULL OR "deferred_unit_price_usd" > 0),
    ADD CONSTRAINT "order_items_deferred_usd_needs_deferred_price"
        CHECK ("deferred_unit_price_usd" IS NULL OR "deferred_unit_price" IS NOT NULL);

-- Immutable like the so'm snapshots: the same function, a wider WHEN clause.
DROP TRIGGER "order_items_price_snapshots_guard" ON "order_items";
CREATE TRIGGER "order_items_price_snapshots_guard"
    BEFORE UPDATE ON "order_items"
    FOR EACH ROW
    WHEN (
        OLD."full_unit_price" IS DISTINCT FROM NEW."full_unit_price"
        OR OLD."deferred_unit_price" IS DISTINCT FROM NEW."deferred_unit_price"
        OR OLD."full_unit_price_usd" IS DISTINCT FROM NEW."full_unit_price_usd"
        OR OLD."deferred_unit_price_usd" IS DISTINCT FROM NEW."deferred_unit_price_usd"
    )
    EXECUTE FUNCTION order_items_price_snapshots_immutable();

-- An order's USD total is the sum of its lines, as the api computes it after an edit. Only for the
-- rewrite below, which cannot hold a subquery itself; gone at the end of the session.
CREATE FUNCTION pg_temp.order_lines_usd(the_order UUID, the_rate NUMERIC) RETURNS NUMERIC AS $$
    SELECT COALESCE(sum(round("line_total"::NUMERIC(40,20) / the_rate, 6)), 0)
    FROM "order_items" WHERE "order_id" = the_order;
$$ LANGUAGE SQL STABLE;

-- Not an UPDATE: orders past SUBMITTED and voided payments are frozen by row triggers. A table
-- rewrite fills the new columns without firing them and leaves every existing column untouched. A
-- transform cannot hold a subquery, hence the DO block. numeric(40,20) keeps enough digits for the
-- half-unit decision, like the Decimal division in the api.
DO $$
DECLARE
    rate_text TEXT;
    current_rate NUMERIC;
    order_count BIGINT;
    payment_count BIGINT;
BEGIN
    SELECT "value" ->> 'rate' INTO rate_text FROM "app_settings" WHERE "key" = 'usd_rate';
    IF rate_text ~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,4})?$' AND rate_text::NUMERIC > 0 THEN
        current_rate := rate_text::NUMERIC;
    END IF;

    IF current_rate IS NULL THEN
        SELECT count(*) INTO order_count FROM "orders";
        SELECT count(*) INTO payment_count FROM "organization_payments";
        -- Never invent a rate: nothing to convert is fine, something to convert is not.
        IF order_count > 0 OR payment_count > 0 THEN
            RAISE EXCEPTION 'usd_organization_debt: % orders and % payments exist but the usd_rate setting is missing or invalid. Nothing was changed. To recover: set the USD rate, run "prisma migrate resolve --rolled-back 20261114090000_usd_organization_debt", then deploy again. Until the resolve command is run, every later deploy stops with P3009.',
                order_count, payment_count;
        END IF;
    ELSE
        EXECUTE format(
            'ALTER TABLE "orders"
                ALTER COLUMN "usd_rate" TYPE DECIMAL(18,4) USING %1$L::NUMERIC,
                ALTER COLUMN "total_usd" TYPE DECIMAL(18,6)
                    USING pg_temp.order_lines_usd("id", %1$L::NUMERIC)',
            current_rate);
        EXECUTE format(
            'ALTER TABLE "organization_payments"
                ALTER COLUMN "rate" TYPE DECIMAL(18,4) USING %1$L::NUMERIC,
                ALTER COLUMN "amount_usd" TYPE DECIMAL(18,6)
                    USING round("amount"::NUMERIC(40,20) / %1$L::NUMERIC, 6)',
            current_rate);
    END IF;
END;
$$;

DROP FUNCTION pg_temp.order_lines_usd(UUID, NUMERIC);

ALTER TABLE "orders"
    ALTER COLUMN "usd_rate" SET NOT NULL,
    ALTER COLUMN "total_usd" SET NOT NULL,
    ADD CONSTRAINT "orders_usd_rate_positive" CHECK ("usd_rate" > 0),
    -- Not an exact recomputation: a USD line is quantity x its USD price while its so'm total is
    -- rounded per unit, so the two differ on purpose. This catches a total counted at a wrong rate or
    -- in the wrong currency: half the so'm total, plus one so'm for the smallest amounts.
    ADD CONSTRAINT "orders_total_usd_sane"
        CHECK ("total_usd" >= 0
            AND abs("total_usd" * "usd_rate" - "total_amount") <= "total_amount" / 2 + 1);

ALTER TABLE "organization_payments"
    ALTER COLUMN "amount_usd" SET NOT NULL,
    ADD CONSTRAINT "organization_payments_currency_known" CHECK ("currency" IN ('USD', 'UZS')),
    -- >= 0, not > 0: an old so'm payment too small for six decimals must not stop this migration. The
    -- service refuses a new payment worth under half a cent.
    ADD CONSTRAINT "organization_payments_amount_usd_non_negative" CHECK ("amount_usd" >= 0),
    ADD CONSTRAINT "organization_payments_usd_value_exact"
        CHECK (
            ("currency" = 'USD' AND "rate" IS NULL AND "amount_usd" = "amount")
            OR ("currency" = 'UZS' AND "rate" > 0
                AND "amount_usd" = round("amount"::NUMERIC(40,20) / "rate", 6))
        );

-- The rate of an order is what the owner's rule freezes: no later write may move it. Created after
-- the rewrite above (which fires no row trigger anyway).
CREATE FUNCTION orders_usd_rate_frozen() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the USD rate of an order is frozen at submit'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_usd_rate_frozen_guard"
    BEFORE UPDATE ON "orders"
    FOR EACH ROW
    WHEN (OLD."usd_rate" IS DISTINCT FROM NEW."usd_rate")
    EXECUTE FUNCTION orders_usd_rate_frozen();

-- Hard rule 12: the assigned values are history. A system action, so the actor is NULL; the CHECK
-- requires a named prefix for that. One row per payment and one per order: a backfilled order is not
-- a workflow step, and an order event would show on the customer's timeline.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_required";
ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_required"
    CHECK (
        "actor_user_id" IS NOT NULL
        OR left("action", 11) = 'SHEET_SYNC_'
        OR left("action", 13) = 'RATE_REFRESH_'
        OR left("action", 10) = 'BOOTSTRAP_'
        OR left("action", 9) = 'TELEGRAM_'
        OR left("action", 5) = 'AUTH_'
        OR left("action", 11) = 'PRICE_POST_'
        OR left("action", 4) = 'CLI_'
        OR left("action", 10) = 'MIGRATION_'
    );

INSERT INTO "audit_log" ("id", "actor_user_id", "entity_type", "entity_id", "action", "diff", "created_at")
SELECT
    gen_random_uuid(), NULL, 'ORGANIZATION_PAYMENT', "id"::TEXT, 'MIGRATION_USD_PAYMENT_BACKFILLED',
    jsonb_build_object(
        'currency', jsonb_build_object('from', NULL, 'to', "currency"),
        'rate', jsonb_build_object('from', NULL, 'to', "rate"::TEXT),
        'amountUsd', jsonb_build_object('from', NULL, 'to', "amount_usd"::TEXT)
    ),
    now()
FROM "organization_payments";

INSERT INTO "audit_log" ("id", "actor_user_id", "entity_type", "entity_id", "action", "diff", "created_at")
SELECT
    gen_random_uuid(), NULL, 'ORDER', "id"::TEXT, 'MIGRATION_USD_ORDER_BACKFILLED',
    jsonb_build_object(
        'usdRate', jsonb_build_object('from', NULL, 'to', "usd_rate"::TEXT),
        'totalUsd', jsonb_build_object('from', NULL, 'to', "total_usd"::TEXT)
    ),
    now()
FROM "orders";

-- PAID / UNPAID is now compared in USD. Orders settled exactly in so'm stay PAID, thanks to the six
-- decimals and the half cent; a real difference is rewritten here, with one event per order that
-- changed (hard rule 12), and nothing is written for an order that did not. Same walk as
-- allocatePayments in the api, same half cent as USD_SETTLED_UNDER (a test compares them). No person
-- did this: the actor is the system.
DO $$
DECLARE
    settled_under CONSTANT NUMERIC := 0.005;
    organization UUID;
    money_left NUMERIC;
    walking BOOLEAN;
    item RECORD;
    next_status "payment_status";
BEGIN
    FOR organization IN
        SELECT DISTINCT "organization_id" FROM "orders" WHERE "status" = 'RECEIVED'
    LOOP
        SELECT COALESCE(sum("amount_usd"), 0) INTO money_left
            FROM "organization_payments"
            WHERE "organization_id" = organization AND "voided_at" IS NULL;
        walking := TRUE;
        FOR item IN
            SELECT "id", "total_usd", "payment_status" FROM "orders"
            WHERE "organization_id" = organization AND "status" = 'RECEIVED'
            ORDER BY "received_at", "order_number"
        LOOP
            walking := walking AND money_left > 0 AND item."total_usd" - money_left < settled_under;
            IF walking THEN
                money_left := money_left - item."total_usd";
            END IF;
            next_status := CASE WHEN walking THEN 'PAID' ELSE 'UNPAID' END;
            IF next_status <> item."payment_status" THEN
                UPDATE "orders" SET "payment_status" = next_status, "updated_at" = now()
                    WHERE "id" = item."id";
                INSERT INTO "order_events"
                    ("id", "order_id", "event_type", "actor_role", "payload", "created_at")
                VALUES (
                    gen_random_uuid(), item."id", 'PAYMENT_STATUS_CHANGED', 'SYSTEM',
                    jsonb_build_object(
                        'before', jsonb_build_object('paymentStatus', item."payment_status"),
                        'after', jsonb_build_object('paymentStatus', next_status)
                    ),
                    now()
                );
            END IF;
        END LOOP;
    END LOOP;
END;
$$;
