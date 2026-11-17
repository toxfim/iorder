-- AlterTable
ALTER TABLE "audit_log" ALTER COLUMN "actor_user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "price_reference" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "delivery_ref" TEXT NOT NULL,
    "delivered_quantity" DECIMAL(18,3) NOT NULL,
    "available_quantity" DECIMAL(18,3) NOT NULL,
    "cost_usd" DECIMAL(18,4) NOT NULL,
    "usd_rate_used" DECIMAL(18,4) NOT NULL,
    "cost_uzs" DECIMAL(18,2) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_reference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_reference_product_id_delivered_at_idx" ON "price_reference"("product_id", "delivered_at");

-- CreateIndex
CREATE UNIQUE INDEX "price_reference_product_id_delivery_ref_key" ON "price_reference"("product_id", "delivery_ref");

-- AddForeignKey
ALTER TABLE "price_reference" ADD CONSTRAINT "price_reference_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- audit_log.actor_user_id NULL means "system action" (the sheet sync). The append-only
-- triggers are unaffected.

-- Cost data sanity (staff-only table, data-model §6.2). Quantities and costs are never
-- negative; the rate used must be positive. All columns are fixed-point decimals.
ALTER TABLE "price_reference"
    ADD CONSTRAINT "price_reference_quantities_non_negative"
        CHECK ("delivered_quantity" >= 0 AND "available_quantity" >= 0),
    ADD CONSTRAINT "price_reference_costs_non_negative"
        CHECK ("cost_usd" >= 0 AND "cost_uzs" >= 0),
    ADD CONSTRAINT "price_reference_rate_positive" CHECK ("usd_rate_used" > 0),
    ADD CONSTRAINT "price_reference_delivery_ref_not_blank" CHECK (btrim("delivery_ref") <> '');

-- Reuse the TRUNCATE guard from the hardening migration.
CREATE TRIGGER "price_reference_no_truncate"
    BEFORE TRUNCATE ON "price_reference"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
