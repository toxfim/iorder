-- SKU rule [C, 2026-10-20, replaces "store uppercase"]: a SKU is stored AS ENTERED (trimmed),
-- e.g. HONOR-X7C-6GB128GB-MidnightBlack. Uniqueness and every lookup ignore letter case.
-- Allowed: Latin letters, digits and - . _ /  ; first character a letter or digit; 1..64 long.
--
-- Case-insensitive uniqueness uses a STORED GENERATED column plus an ordinary unique index
-- instead of an expression index on lower(sku) or the citext extension:
--   * Prisma cannot express expression indexes, but it CAN query and filter a plain column, so
--     the application looks products up by sku_key without raw SQL;
--   * no extension is needed (the production database role may not be allowed to create one);
--   * the database computes the key, so no code path can forget or get it wrong.
-- lower() is exact here because the character set is ASCII only (enforced below).
--
-- This migration FAILS LOUDLY, on purpose, when existing data does not fit:
--   * a case-only duplicate (two rows that differ only in letter case) violates the new unique
--     index when it is created;
--   * a SKU with a character outside the allowed set violates the new CHECK.
-- Both are data decisions for a human, not for a migration. Rows written under the old
-- uppercase rule (KB-15) already satisfy the new rule and stay as they are.

ALTER TABLE "products" DROP CONSTRAINT "products_sku_normalized";

ALTER TABLE "products"
    ADD CONSTRAINT "products_sku_format"
    CHECK ("sku" = btrim("sku") AND "sku" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$');

ALTER TABLE "products"
    ADD COLUMN "sku_key" TEXT GENERATED ALWAYS AS (lower("sku")) STORED NOT NULL;

CREATE UNIQUE INDEX "products_sku_key_key" ON "products" ("sku_key");
