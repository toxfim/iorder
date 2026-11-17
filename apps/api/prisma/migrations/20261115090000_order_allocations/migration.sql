-- Stock holds ([C] owner 2026-10-30): from the manager's approval until RELEASED, REJECTED or
-- CANCELLED an order holds quantity on chosen delivery lines. The sheet stays the source of the real
-- stock and nothing here touches stock_cache or price_reference: available = sheet available minus
-- active holds. Additive only: one new table and one new event type.

-- Not used in this migration, so it may share the transaction that adds it.
ALTER TYPE "order_event_type" ADD VALUE 'ALLOCATION_CHANGED';

CREATE TABLE "order_allocations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_reference_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "hold_ended_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,

    CONSTRAINT "order_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_allocations_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "order_allocations_void_complete"
        CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL)),
    -- A row leaves the active set one way: replaced by the manager, or its hold ended with the order.
    CONSTRAINT "order_allocations_ended_or_voided"
        CHECK ("hold_ended_at" IS NULL OR "voided_at" IS NULL)
);

ALTER TABLE "order_allocations"
    ADD CONSTRAINT "order_allocations_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "order_allocations_order_item_id_fkey"
        FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "order_allocations_product_id_fkey"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "order_allocations_price_reference_id_fkey"
        FOREIGN KEY ("price_reference_id") REFERENCES "price_reference"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "order_allocations_created_by_fkey"
        FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "order_allocations_voided_by_fkey"
        FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "order_allocations_order_id_idx" ON "order_allocations"("order_id");

-- Only active holds are summed, so only they are indexed.
CREATE INDEX "order_allocations_active_line_idx" ON "order_allocations"("price_reference_id")
    WHERE "hold_ended_at" IS NULL AND "voided_at" IS NULL;
CREATE INDEX "order_allocations_active_product_idx" ON "order_allocations"("product_id")
    WHERE "hold_ended_at" IS NULL AND "voided_at" IS NULL;
-- One active row per order line and delivery line. Ended holds stay as the record of what shipped
-- from where, so this cannot be a plain unique index.
CREATE UNIQUE INDEX "order_allocations_active_unique"
    ON "order_allocations"("order_item_id", "price_reference_id")
    WHERE "hold_ended_at" IS NULL AND "voided_at" IS NULL;

-- History (hard rule 12): no delete, and only the ending columns change, each once.
CREATE FUNCTION order_allocations_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'order_allocations are voided, never deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."hold_ended_at" IS NOT NULL OR NEW."voided_at" IS NOT NULL THEN
            RAISE EXCEPTION 'a new allocation must be active'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM "order_items" i
            WHERE i."id" = NEW."order_item_id" AND i."order_id" = NEW."order_id"
              AND i."product_id" = NEW."product_id"
        ) THEN
            RAISE EXCEPTION 'an allocation must name the order and product of its order line'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM "price_reference" p
            WHERE p."id" = NEW."price_reference_id" AND p."product_id" = NEW."product_id"
        ) THEN
            RAISE EXCEPTION 'an allocation must name a delivery line of its own product'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW."id", NEW."order_id", NEW."order_item_id", NEW."product_id", NEW."price_reference_id",
        NEW."quantity", NEW."created_by", NEW."created_at")
       IS DISTINCT FROM
       (OLD."id", OLD."order_id", OLD."order_item_id", OLD."product_id", OLD."price_reference_id",
        OLD."quantity", OLD."created_by", OLD."created_at")
       OR (OLD."hold_ended_at" IS NOT NULL AND NEW."hold_ended_at" IS DISTINCT FROM OLD."hold_ended_at")
       OR (OLD."voided_at" IS NOT NULL
           AND (NEW."voided_at" IS DISTINCT FROM OLD."voided_at"
                OR NEW."voided_by" IS DISTINCT FROM OLD."voided_by")) THEN
        RAISE EXCEPTION 'an allocation can only end its hold or be voided, once'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "order_allocations_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "order_allocations"
    FOR EACH ROW EXECUTE FUNCTION order_allocations_guard();
