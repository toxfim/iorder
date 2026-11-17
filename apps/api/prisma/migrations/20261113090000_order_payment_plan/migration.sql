-- Owner 2026-10-29: the customer chooses how to pay ("To'lov turi"): FULL at the sale price or
-- DEFERRED in parts at the deferred price. Nothing to do with payment_method ("Savdo turi").
ALTER TYPE "order_event_type" ADD VALUE 'PAYMENT_PLAN_CHANGED';

CREATE TYPE "payment_plan" AS ENUM ('FULL', 'DEFERRED');

-- Every existing order was priced at the sale price.
ALTER TABLE "orders" ADD COLUMN "payment_plan" "payment_plan" NOT NULL DEFAULT 'FULL';

-- Both prices are snapshotted per line, so the manager's plan change never reads the current price
-- list (hard rule 4). Existing lines keep a NULL deferred price: it was never recorded for them.
ALTER TABLE "order_items"
    ADD COLUMN "full_unit_price" DECIMAL(18,2),
    ADD COLUMN "deferred_unit_price" DECIMAL(18,2);

-- Not an UPDATE: the items of an order that left SUBMITTED are frozen by a row trigger. This table
-- rewrite fills the new column without firing it, and leaves every existing column untouched.
ALTER TABLE "order_items" ALTER COLUMN "full_unit_price" TYPE DECIMAL(18,2) USING "unit_price";
ALTER TABLE "order_items" ALTER COLUMN "full_unit_price" SET NOT NULL;

ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_full_unit_price_non_negative" CHECK ("full_unit_price" >= 0),
    ADD CONSTRAINT "order_items_deferred_unit_price_non_negative"
        CHECK ("deferred_unit_price" IS NULL OR "deferred_unit_price" >= 0),
    -- The charged price is always one of the two snapshots: a plan change cannot invent a third.
    ADD CONSTRAINT "order_items_unit_price_is_a_snapshot"
        CHECK (
            "unit_price" = "full_unit_price"
            OR ("deferred_unit_price" IS NOT NULL AND "unit_price" = "deferred_unit_price")
        );

-- The plan follows the items: it can change only while the order is SUBMITTED, and never silently.
CREATE FUNCTION orders_payment_plan_only_while_submitted() RETURNS trigger AS $$
BEGIN
    IF NEW."payment_plan" IS DISTINCT FROM OLD."payment_plan" THEN
        IF OLD."status" <> 'SUBMITTED' THEN
            RAISE EXCEPTION 'the payment plan is immutable once the order left SUBMITTED'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW."row_version" = OLD."row_version" THEN
            RAISE EXCEPTION 'the payment plan can only change together with row_version'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_payment_plan_guard"
    BEFORE UPDATE OF "payment_plan" ON "orders"
    FOR EACH ROW EXECUTE FUNCTION orders_payment_plan_only_while_submitted();

-- The snapshots are what a plan change reads, so nobody may rewrite them. Created after the column
-- rewrite above (which fires no row trigger anyway). The WHEN clause leaves quantity and charged
-- price updates alone: only a real change of a snapshot is refused.
CREATE FUNCTION order_items_price_snapshots_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the price snapshots of an order line are immutable'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "order_items_price_snapshots_guard"
    BEFORE UPDATE ON "order_items"
    FOR EACH ROW
    WHEN (
        OLD."full_unit_price" IS DISTINCT FROM NEW."full_unit_price"
        OR OLD."deferred_unit_price" IS DISTINCT FROM NEW."deferred_unit_price"
    )
    EXECUTE FUNCTION order_items_price_snapshots_immutable();
