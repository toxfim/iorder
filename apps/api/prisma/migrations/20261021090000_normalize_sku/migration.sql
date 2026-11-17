-- SKUs are stored trimmed and UPPERCASE [C, 2026-10-20]: "kb-15" and "KB-15" are one product.
-- The application normalizes on every write and lookup; this makes the database refuse the rest.

-- Normalize existing rows first. If two rows differ only in case or spaces, the unique index on
-- sku makes this statement fail loudly: that is a data decision for a human, not for a migration.
UPDATE "products" SET "sku" = upper(btrim("sku")) WHERE "sku" <> upper(btrim("sku"));

ALTER TABLE "products"
    ADD CONSTRAINT "products_sku_normalized" CHECK ("sku" = upper(btrim("sku")) AND "sku" <> '');
