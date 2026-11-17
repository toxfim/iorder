-- «Поставка» rows we read [C, 2026-10-20, data-model §6.4]:
--  1. price_reference (staff-only) gains supplier, purchase method and category per delivery line.
--     The table name is historical: it holds ALL delivery lines of the selected suppliers.
--  2. stock_cache: the stock AGGREGATE per product (sum of available quantity over its delivery
--     lines). It carries no cost and no supplier by design.

-- Rows that exist before this migration came from tests/dev data and have no supplier data. They
-- get an explicit "(unknown)" marker, not an invented supplier; the next sync overwrites it and
-- the audit log records the change from "(unknown)". The default is dropped right away so every
-- later insert must name the values.
ALTER TABLE "price_reference"
    ADD COLUMN "supplier" TEXT NOT NULL DEFAULT '(unknown)',
    ADD COLUMN "purchase_method" TEXT NOT NULL DEFAULT '(unknown)',
    ADD COLUMN "category" TEXT NOT NULL DEFAULT '(unknown)';

ALTER TABLE "price_reference"
    ALTER COLUMN "supplier" DROP DEFAULT,
    ALTER COLUMN "purchase_method" DROP DEFAULT,
    ALTER COLUMN "category" DROP DEFAULT;

ALTER TABLE "price_reference"
    ADD CONSTRAINT "price_reference_supplier_not_blank" CHECK (btrim("supplier") <> ''),
    ADD CONSTRAINT "price_reference_purchase_method_not_blank" CHECK (btrim("purchase_method") <> ''),
    ADD CONSTRAINT "price_reference_category_not_blank" CHECK (btrim("category") <> '');

CREATE TABLE "stock_cache" (
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_cache_pkey" PRIMARY KEY ("product_id")
);

ALTER TABLE "stock_cache"
    ADD CONSTRAINT "stock_cache_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indicative stock is never negative.
ALTER TABLE "stock_cache"
    ADD CONSTRAINT "stock_cache_quantity_non_negative" CHECK ("quantity" >= 0);

-- Reuse the TRUNCATE guard from the hardening migration.
CREATE TRIGGER "stock_cache_no_truncate"
    BEFORE TRUNCATE ON "stock_cache"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
