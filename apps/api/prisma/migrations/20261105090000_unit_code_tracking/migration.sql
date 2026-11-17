-- Unit identification codes ([C] 2026-10-25, the reference-distributor model): staff-managed product
-- categories supply DEFAULTS (copied when a product is linked, never retroactive); the product's
-- own tracking_type / marking_required is the rule; the warehouse scans IMEI / SN / marking per
-- unit while picking (order ACCOUNTING_CLEARED); release is refused until every required code is
-- there. One order_units row per physical piece, also for quantity goods.

CREATE TYPE "tracking_type" AS ENUM ('NONE', 'IMEI', 'SERIAL');
CREATE TYPE "unit_code_kind" AS ENUM ('IMEI', 'SERIAL', 'MARKING');

ALTER TYPE "order_event_type" ADD VALUE 'UNIT_CODE_RECORDED';
ALTER TYPE "order_event_type" ADD VALUE 'UNIT_CODE_CLEARED';

-- ---------------------------------------------------------------- product categories

CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT GENERATED ALWAYS AS (lower(btrim("name"))) STORED NOT NULL,
    "tracking_type_default" "tracking_type" NOT NULL DEFAULT 'NONE',
    "marking_required_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_categories_name_valid" CHECK (btrim("name") <> '' AND length("name") <= 200)
);
CREATE UNIQUE INDEX "product_categories_name_key_key" ON "product_categories"("name_key");

CREATE FUNCTION product_categories_never_deleted() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product_categories are archived, never deleted (% rejected)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_categories_no_delete"
    BEFORE DELETE ON "product_categories"
    FOR EACH ROW EXECUTE FUNCTION product_categories_never_deleted();
CREATE TRIGGER "product_categories_no_truncate"
    BEFORE TRUNCATE ON "product_categories"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

ALTER TABLE "products" ADD COLUMN "category_id" UUID,
ADD COLUMN "marking_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "tracking_type" "tracking_type" NOT NULL DEFAULT 'NONE';
CREATE INDEX "products_category_id_idx" ON "products"("category_id");
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Owner 2026-10-25: quantities are whole pieces. NOT VALID: rows written before this rule stay as
-- history; every new or changed row must be whole.
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_whole"
    CHECK ("quantity" = trunc("quantity")) NOT VALID;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_whole"
    CHECK ("quantity" = trunc("quantity")) NOT VALID;

-- ---------------------------------------------------------------- order units

CREATE TABLE "order_units" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_no" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_units_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_units_unit_no_positive" CHECK ("unit_no" >= 1)
);
CREATE INDEX "order_units_order_id_idx" ON "order_units"("order_id");
CREATE INDEX "order_units_product_id_idx" ON "order_units"("product_id");
CREATE UNIQUE INDEX "order_units_order_item_id_unit_no_key" ON "order_units"("order_item_id", "unit_no");
ALTER TABLE "order_units" ADD CONSTRAINT "order_units_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_units" ADD CONSTRAINT "order_units_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_units" ADD CONSTRAINT "order_units_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION order_units_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'order_units is append-only (% rejected)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "order_units_no_update_delete"
    BEFORE UPDATE OR DELETE ON "order_units"
    FOR EACH ROW EXECUTE FUNCTION order_units_append_only();
CREATE TRIGGER "order_units_no_truncate"
    BEFORE TRUNCATE ON "order_units"
    FOR EACH STATEMENT EXECUTE FUNCTION order_units_append_only();

-- ---------------------------------------------------------------- unit codes

CREATE TABLE "unit_codes" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "kind" "unit_code_kind" NOT NULL,
    "slot" SMALLINT NOT NULL,
    "code_value" TEXT NOT NULL,
    "code_key" TEXT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_reason" TEXT,

    CONSTRAINT "unit_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unit_codes_slot_valid" CHECK ("slot" IN (1, 2) AND ("kind" = 'IMEI' OR "slot" = 1)),
    CONSTRAINT "unit_codes_value_length" CHECK (
        length("code_value") BETWEEN 1 AND 512 AND length("code_key") BETWEEN 1 AND 512
    ),
    CONSTRAINT "unit_codes_void_complete" CHECK (
        ("voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
        OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL
            AND "void_reason" IN ('REPLACED', 'CLEARED', 'ORDER_CANCELLED'))
    )
);
CREATE INDEX "unit_codes_unit_id_idx" ON "unit_codes"("unit_id");
CREATE INDEX "unit_codes_order_id_idx" ON "unit_codes"("order_id");
CREATE INDEX "unit_codes_code_key_idx" ON "unit_codes"("code_key");
-- One live value per unit, kind and slot.
CREATE UNIQUE INDEX "unit_codes_live_slot_key" ON "unit_codes"("unit_id", "kind", "slot")
    WHERE "voided_at" IS NULL;
-- IMEI (without the slot: an IMEI1 of one unit can never be the IMEI2 of another) and marking
-- codes are unique across all live rows of all orders and customers.
CREATE UNIQUE INDEX "unit_codes_live_global_key" ON "unit_codes"("kind", "code_key")
    WHERE "voided_at" IS NULL AND "kind" IN ('IMEI', 'MARKING');
-- Serial numbers repeat across brands: unique per product.
CREATE UNIQUE INDEX "unit_codes_live_serial_key" ON "unit_codes"("product_id", "code_key")
    WHERE "voided_at" IS NULL AND "kind" = 'SERIAL';

ALTER TABLE "unit_codes" ADD CONSTRAINT "unit_codes_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "order_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_codes" ADD CONSTRAINT "unit_codes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_codes" ADD CONSTRAINT "unit_codes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_codes" ADD CONSTRAINT "unit_codes_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_codes" ADD CONSTRAINT "unit_codes_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A code row is never deleted and never rewritten: the only change is setting the void columns
-- once (rescan, clear, cancelled order). New codes only while the order is being picked.
CREATE FUNCTION unit_codes_guard() RETURNS trigger AS $$
DECLARE
    current_status "order_status";
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'unit_codes are voided, never deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT o."status" INTO current_status FROM "orders" o WHERE o."id" = NEW."order_id";
        IF current_status IS DISTINCT FROM 'ACCOUNTING_CLEARED' THEN
            RAISE EXCEPTION 'unit codes can be recorded only while the order is ACCOUNTING_CLEARED'
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

CREATE TRIGGER "unit_codes_guard_rows"
    BEFORE INSERT OR UPDATE OR DELETE ON "unit_codes"
    FOR EACH ROW EXECUTE FUNCTION unit_codes_guard();
CREATE TRIGGER "unit_codes_no_truncate"
    BEFORE TRUNCATE ON "unit_codes"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- ---------------------------------------------------------------- My Products introduction

CREATE TABLE "customer_goods_discovery_acks" (
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_goods_discovery_acks_pkey" PRIMARY KEY ("user_id","organization_id")
);
ALTER TABLE "customer_goods_discovery_acks" ADD CONSTRAINT "customer_goods_discovery_acks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_goods_discovery_acks" ADD CONSTRAINT "customer_goods_discovery_acks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- existing orders

-- Orders that already reached ACCOUNTING_CLEARED get their unit rows (whole quantities only), so
-- the picking screen and My Products work for them too. No codes are invented.
INSERT INTO "order_units" ("id", "order_id", "order_item_id", "product_id", "unit_no", "created_at")
SELECT gen_random_uuid(), i."order_id", i."id", i."product_id", n,
       COALESCE(o."accounting_cleared_at", o."updated_at")
FROM "order_items" i
JOIN "orders" o ON o."id" = i."order_id"
CROSS JOIN LATERAL generate_series(1, i."quantity"::integer) AS n
WHERE o."accounting_cleared_at" IS NOT NULL
  AND i."quantity" = trunc(i."quantity");
