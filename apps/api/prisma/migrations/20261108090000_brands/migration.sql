-- Brands ([C] 2026-10-28): the price list Excel file posted to the organization groups has one
-- sheet per brand. A product's brand is the one staff chose (products.brand_id) or, when none is
-- chosen, the brand whose name appears in the product name (the "brand finder", in code).
-- Brands are added, never renamed or deleted by the application (grants: SELECT, INSERT).

CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- Case-insensitive uniqueness (the same pattern as product_categories.name_key). Never
    -- written by the application.
    "name_key" TEXT GENERATED ALWAYS AS (lower(btrim("name"))) STORED NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Who created it (the authenticated actor's id, like price_list_versions.published_by: no
    -- foreign key). NULL only for the rows seeded below.
    "created_by_user_id" TEXT,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "brands_name_valid" CHECK (btrim("name") <> '' AND "name" = btrim("name") AND length("name") <= 80)
);
CREATE UNIQUE INDEX "brands_name_key_key" ON "brands"("name_key");

-- The brand staff chose for a product; NULL = found from the name (or none).
ALTER TABLE "products" ADD COLUMN "brand_id" UUID;
CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed [P]: the brands seen in the real product names (2026-10-28). Random v4 ids: the
-- application creates v7 ids, the order of these few seeded rows does not matter.
INSERT INTO "brands" ("id", "name") VALUES
    (gen_random_uuid(), 'Xiaomi'),
    (gen_random_uuid(), 'Redmi'),
    (gen_random_uuid(), 'Mijia'),
    (gen_random_uuid(), 'Huawei'),
    (gen_random_uuid(), 'Motorola'),
    (gen_random_uuid(), 'Black Shark');

-- A sixth system audit source: the daily automatic price list post (PRICE_POST_*) has no person.
-- Rewritten as the UNION of all sources, like the earlier migrations of this constraint.
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_actor_required";

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_required"
    CHECK (
        "actor_user_id" IS NOT NULL
        OR left("action", 11) = 'SHEET_SYNC_'
        OR left("action", 13) = 'RATE_REFRESH_'
        OR left("action", 10) = 'BOOTSTRAP_'
        OR left("action", 9) = 'TELEGRAM_'
        OR left("action", 5) = 'AUTH_'
        OR left("action", 11) = 'PRICE_POST_'
    );
