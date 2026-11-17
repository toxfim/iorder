-- Owner 2026-11-12 [C]: a fourth organization label, ALIF_FACTORING ("Alif factoring"), with its
-- OWN price tier: a sale and a deferred price per price list item. A product without an Alif sale
-- price is not offered to that tier at all (no fallback). Every existing row keeps what it has: the
-- new columns are null and no organization or order carries the new values yet.

-- AlterEnum
ALTER TYPE "organization_label" ADD VALUE 'ALIF_FACTORING';

-- AlterEnum
ALTER TYPE "price_tier" ADD VALUE 'ALIF_FACTORING';

-- AlterTable
ALTER TABLE "price_list_items" ADD COLUMN     "alif_deferred_price" DECIMAL(18,2),
ADD COLUMN     "alif_price" DECIMAL(18,2);

-- ---------------------------------------------------------------------------------------------
-- Hand-written: what Prisma cannot express. Like the wholesale tier: positive, and no deferred
-- price without a sale price. (price_list_items_guard freezes the whole row of a published version.)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_alif_price_positive"
    CHECK ("alif_price" IS NULL OR "alif_price" > 0);
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_alif_deferred_price_positive"
    CHECK ("alif_deferred_price" IS NULL OR "alif_deferred_price" > 0);
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_alif_deferred_needs_price"
    CHECK ("alif_deferred_price" IS NULL OR "alif_price" IS NOT NULL);
