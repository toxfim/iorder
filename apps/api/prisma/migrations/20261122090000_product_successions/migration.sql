-- "Newer model" pairs [C, owner 2026-11-09]: the system proposes (older product -> newer product)
-- from product names, a manager or admin confirms or rejects, and only a CONFIRMED pair is ever
-- shown to a customer who bought the older product (the "Yangi model" block of the customer home).

CREATE TYPE "product_succession_status" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED');

CREATE TABLE "product_successions" (
    "id" UUID NOT NULL,
    "older_product_id" UUID NOT NULL,
    "newer_product_id" UUID NOT NULL,
    "status" "product_succession_status" NOT NULL DEFAULT 'PROPOSED',
    "proposed_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_successions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "product_successions"
    ADD CONSTRAINT "product_successions_older_product_id_fkey"
    FOREIGN KEY ("older_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "product_successions_newer_product_id_fkey"
    FOREIGN KEY ("newer_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One row per pair; a product is never its own successor.
CREATE UNIQUE INDEX "product_successions_older_product_id_newer_product_id_key"
    ON "product_successions" ("older_product_id", "newer_product_id");
CREATE INDEX "product_successions_status_proposed_at_idx"
    ON "product_successions" ("status", "proposed_at");
CREATE INDEX "product_successions_newer_product_id_idx"
    ON "product_successions" ("newer_product_id");

ALTER TABLE "product_successions"
    ADD CONSTRAINT "product_successions_distinct_products"
    CHECK ("older_product_id" <> "newer_product_id"),
    -- PROPOSED is undecided; a decision always has a person and a time.
    ADD CONSTRAINT "product_successions_decision_consistent" CHECK (
        ("status" = 'PROPOSED' AND "decided_at" IS NULL AND "decided_by" IS NULL)
        OR ("status" <> 'PROPOSED' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL)
    );

-- The pair itself never changes and a decided pair never becomes a proposal again. Rows are never
-- deleted (the application role has no DELETE grant; this is the second line).
CREATE FUNCTION product_successions_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'product successions cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."id" <> OLD."id"
        OR NEW."older_product_id" <> OLD."older_product_id"
        OR NEW."newer_product_id" <> OLD."newer_product_id"
        OR NEW."proposed_at" <> OLD."proposed_at" THEN
        RAISE EXCEPTION 'product succession % may only be decided, its pair is fixed', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."status" = 'PROPOSED' AND OLD."status" <> 'PROPOSED' THEN
        RAISE EXCEPTION 'product succession % is decided and cannot become a proposal again', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_successions_guard"
    BEFORE UPDATE OR DELETE ON "product_successions"
    FOR EACH ROW EXECUTE FUNCTION product_successions_guard();

CREATE TRIGGER "product_successions_no_truncate"
    BEFORE TRUNCATE ON "product_successions"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
