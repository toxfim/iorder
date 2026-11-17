-- Product decision [C, 2026-10-20]: the company has ONE main key, the sheet's product id
-- («Товар_ID»); the separate SKU concept is dropped. Pure renames: no data is dropped, copied
-- or rewritten, and every rule of the previous migration (stored as entered, trimmed, unique
-- ignoring letter case, same character set and length, immutable after creation) stays.
--
-- Renaming the base column also updates the expression of the generated key column and of the
-- CHECK constraint, because PostgreSQL stores them by column number, not by name.
--
-- Not renamed on purpose: old audit_log rows keep their historical field name "sku" inside
-- the JSON diff. The audit log is append-only; history is not rewritten.

ALTER TABLE "products" RENAME COLUMN "sku" TO "product_code";
ALTER TABLE "products" RENAME COLUMN "sku_key" TO "product_code_key";

ALTER TABLE "products" RENAME CONSTRAINT "products_sku_format" TO "products_product_code_format";

ALTER INDEX "products_sku_key" RENAME TO "products_product_code_key";
ALTER INDEX "products_sku_key_key" RENAME TO "products_product_code_key_key";
