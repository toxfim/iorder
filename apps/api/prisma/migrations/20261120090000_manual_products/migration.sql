-- Staff-added products without a sheet «Товар_ID» [C, owner 2026-11-09]. Such a product gets a
-- SYSTEM-GENERATED code IO-000123 (this sequence, zero-padded to six digits), has no stock and no
-- cost lines, is outside the allocation plan, and can later be MERGED into the sheet product that
-- stands for the same goods. The prefix IO- is reserved for generated codes: the sheet sync and the
-- explicit create refuse it in code, and the CHECK below is the database backstop in both directions.

CREATE SEQUENCE "product_generated_code_seq" AS bigint START WITH 1 MINVALUE 1;

ALTER TABLE "products"
    ADD COLUMN "code_generated" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "merged_into_id" UUID;

CREATE INDEX "products_merged_into_id_idx" ON "products"("merged_into_id");

ALTER TABLE "products" ADD CONSTRAINT "products_merged_into_id_fkey"
    FOREIGN KEY ("merged_into_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A sheet code that already starts with IO- would make the CHECK below fail with an opaque error in
-- the middle of a deploy; name the offending codes instead so they can be renamed first.
DO $$
DECLARE
    offending text;
BEGIN
    SELECT string_agg(product_code, ', ' ORDER BY product_code) INTO offending
    FROM products WHERE product_code ~* '^io-';
    IF offending IS NOT NULL THEN
        RAISE EXCEPTION 'the prefix IO- is reserved for generated product codes; rename these product codes before migrating: %', offending;
    END IF;
END $$;

-- A generated code has the IO- shape and only a generated code may start with IO- (any case).
ALTER TABLE "products" ADD CONSTRAINT "products_generated_code_prefix"
    CHECK (("code_generated" AND "product_code" ~ '^IO-[0-9]{6,}$')
        OR (NOT "code_generated" AND "product_code" !~* '^io-'));

-- Only a generated-code product is merged, never into itself, and a merged product is inactive.
ALTER TABLE "products" ADD CONSTRAINT "products_merged_into_check"
    CHECK ("merged_into_id" IS NULL
        OR ("code_generated" AND NOT "is_active" AND "merged_into_id" <> "id"));

-- A merge moves the source's photos to the target. The photo history guard (migration
-- product_images) kept product_id fixed; it now lets product_id move exactly onto the product the
-- old owner was merged into, and nothing else changes. Rewritten as a whole, like the earlier guards.
CREATE OR REPLACE FUNCTION product_images_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'product image % may not be deleted', OLD.id;
    END IF;
    IF OLD.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'product image % is removed', OLD.id;
    END IF;
    IF NEW.product_id IS DISTINCT FROM OLD.product_id
        AND NOT EXISTS (
            SELECT 1 FROM products p
            WHERE p.id = OLD.product_id AND p.merged_into_id = NEW.product_id
        ) THEN
        RAISE EXCEPTION 'product image % may move only to the product its owner was merged into', OLD.id;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.sha256 IS DISTINCT FROM OLD.sha256
        OR NEW.original_content_type IS DISTINCT FROM OLD.original_content_type
        OR NEW.width IS DISTINCT FROM OLD.width
        OR NEW.height IS DISTINCT FROM OLD.height
        OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
        OR NEW.source_url IS DISTINCT FROM OLD.source_url
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'product image % may only change is_primary or be removed', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
