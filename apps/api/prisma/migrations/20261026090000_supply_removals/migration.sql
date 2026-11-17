-- A delivery line that disappears from the sheet is never deleted silently: the sync opens a
-- removal request and a manager confirms or dismisses it (data-model §6.3 item 3).

-- Soft removal of a delivery line: the row stays (history, audit), but it is excluded from stock,
-- from latest/recent cost queries and from the default cost history. Both columns or neither.
ALTER TABLE "price_reference"
    ADD COLUMN "removed_at" TIMESTAMPTZ(3),
    ADD COLUMN "removed_by" TEXT;

ALTER TABLE "price_reference"
    ADD CONSTRAINT "price_reference_removal_complete"
    CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL));

CREATE TYPE "supply_removal_status" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

CREATE TABLE "supply_removal_requests" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "delivery_ref" TEXT NOT NULL,
    "status" "supply_removal_status" NOT NULL DEFAULT 'PENDING',
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "supply_removal_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "supply_removal_requests"
    ADD CONSTRAINT "supply_removal_requests_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "supply_removal_requests_status_detected_at_idx"
    ON "supply_removal_requests" ("status", "detected_at");

-- At most ONE open request per delivery line (the sync is idempotent on top of this).
CREATE UNIQUE INDEX "supply_removal_requests_one_pending"
    ON "supply_removal_requests" ("product_id", "delivery_ref") WHERE "status" = 'PENDING';

ALTER TABLE "supply_removal_requests"
    ADD CONSTRAINT "supply_removal_requests_delivery_ref_not_blank" CHECK (btrim("delivery_ref") <> ''),
    -- PENDING is undecided; a decision always has a time; a CONFIRMATION always has a person
    -- (only an automatic dismissal by the sync has none).
    ADD CONSTRAINT "supply_removal_requests_decision_consistent" CHECK (
        ("status" = 'PENDING' AND "decided_at" IS NULL AND "decided_by" IS NULL)
        OR ("status" = 'DISMISSED' AND "decided_at" IS NOT NULL)
        OR ("status" = 'CONFIRMED' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL)
    );

CREATE TRIGGER "supply_removal_requests_no_truncate"
    BEFORE TRUNCATE ON "supply_removal_requests"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
