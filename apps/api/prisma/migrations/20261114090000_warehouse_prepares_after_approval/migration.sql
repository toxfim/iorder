-- Warehouse flow ([C] owner 2026-10-30): after the manager's approval the warehouse sees the order
-- and starts preparing and scanning; the release still waits for accounting (or the manager's
-- skip). An order rejected or cancelled after approval tells the warehouse to return the goods
-- ([P]: the "Returned" action and the same treatment of the accountant's rejection).
-- Additive only: nothing is dropped, every new column is nullable.

-- Not used in this migration, so it may share the transaction that adds it.
ALTER TYPE "order_event_type" ADD VALUE 'GOODS_RETURNED';

ALTER TABLE "orders"
    ADD COLUMN "manager_approved_at" TIMESTAMPTZ(3),
    ADD COLUMN "goods_returned_at" TIMESTAMPTZ(3),
    ADD COLUMN "goods_returned_by" UUID;

ALTER TABLE "orders" ADD CONSTRAINT "orders_goods_returned_by_fkey"
    FOREIGN KEY ("goods_returned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- existing orders

-- The approval event is the record of when it happened. Cleared orders without one (rows older
-- than the events) count as approved when they were cleared.
UPDATE "orders" o
SET "manager_approved_at" = COALESCE(
    (SELECT MIN(e."created_at") FROM "order_events" e
     WHERE e."order_id" = o."id" AND e."to_status" = 'MANAGER_APPROVED'),
    o."accounting_cleared_at"
);

-- Before this rule the warehouse never prepared these orders, so there is nothing to bring back.
-- goods_returned_by stays NULL: no person pressed anything, and no order event is invented.
UPDATE "orders"
SET "goods_returned_at" = "updated_at"
WHERE "status" IN ('CANCELLED', 'REJECTED') AND "manager_approved_at" IS NOT NULL;

-- Orders waiting for the accountant get their unit rows now, as cleared orders got theirs in
-- 20261105090000_unit_code_tracking. No codes are invented.
INSERT INTO "order_units" ("id", "order_id", "order_item_id", "product_id", "unit_no", "created_at")
SELECT gen_random_uuid(), i."order_id", i."id", i."product_id", n,
       COALESCE(o."manager_approved_at", o."updated_at")
FROM "order_items" i
JOIN "orders" o ON o."id" = i."order_id"
CROSS JOIN LATERAL generate_series(1, i."quantity"::integer) AS n
WHERE o."status" = 'MANAGER_APPROVED'
  AND i."quantity" = trunc(i."quantity")
ON CONFLICT ("order_item_id", "unit_no") DO NOTHING;

-- ---------------------------------------------------------------- rules

-- Goods go back only from an order that closed without delivery; a person is named only together
-- with the time (the backfill above has a time and no person).
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_goods_returned_only_when_closed"
        CHECK ("goods_returned_at" IS NULL OR "status" IN ('CANCELLED', 'REJECTED')),
    ADD CONSTRAINT "orders_goods_returned_by_has_time"
        CHECK ("goods_returned_by" IS NULL OR "goods_returned_at" IS NOT NULL);

-- Both facts are history: once written they never change.
CREATE FUNCTION orders_warehouse_facts_frozen() RETURNS trigger AS $$
BEGIN
    IF (OLD."manager_approved_at" IS NOT NULL
        AND NEW."manager_approved_at" IS DISTINCT FROM OLD."manager_approved_at")
       OR (OLD."goods_returned_at" IS NOT NULL
           AND (NEW."goods_returned_at" IS DISTINCT FROM OLD."goods_returned_at"
                OR NEW."goods_returned_by" IS DISTINCT FROM OLD."goods_returned_by")) THEN
        RAISE EXCEPTION 'manager_approved_at and goods_returned_* are written once'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_warehouse_facts_frozen_guard"
    BEFORE UPDATE ON "orders"
    FOR EACH ROW EXECUTE FUNCTION orders_warehouse_facts_frozen();

-- A reject frees the scanned codes like a cancel does, under its own reason.
ALTER TABLE "unit_codes" DROP CONSTRAINT "unit_codes_void_complete";
ALTER TABLE "unit_codes" ADD CONSTRAINT "unit_codes_void_complete" CHECK (
    ("voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
    OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL
        AND "void_reason" IN ('REPLACED', 'CLEARED', 'ORDER_CANCELLED', 'ORDER_REJECTED'))
);

-- Same function as 20261105090000_unit_code_tracking, with scanning opened from the manager's
-- approval on.
CREATE OR REPLACE FUNCTION unit_codes_guard() RETURNS trigger AS $$
DECLARE
    current_status "order_status";
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'unit_codes are voided, never deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT o."status" INTO current_status FROM "orders" o WHERE o."id" = NEW."order_id";
        IF current_status IS NULL
           OR current_status NOT IN ('MANAGER_APPROVED', 'ACCOUNTING_CLEARED') THEN
            RAISE EXCEPTION 'unit codes can be recorded only while the order is MANAGER_APPROVED or ACCOUNTING_CLEARED'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW."voided_at" IS NOT NULL THEN
            RAISE EXCEPTION 'a new unit code cannot be voided already'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM "order_units" u
            WHERE u."id" = NEW."unit_id" AND u."order_id" = NEW."order_id"
              AND u."product_id" = NEW."product_id"
        ) THEN
            RAISE EXCEPTION 'a unit code must name the order and product of its unit'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."voided_at" IS NOT NULL
       OR NEW."voided_at" IS NULL
       OR (NEW."id", NEW."unit_id", NEW."order_id", NEW."product_id", NEW."kind", NEW."slot",
           NEW."code_value", NEW."code_key", NEW."recorded_by", NEW."recorded_at")
          IS DISTINCT FROM
          (OLD."id", OLD."unit_id", OLD."order_id", OLD."product_id", OLD."kind", OLD."slot",
           OLD."code_value", OLD."code_key", OLD."recorded_by", OLD."recorded_at") THEN
        RAISE EXCEPTION 'a unit code can only be voided, once'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
