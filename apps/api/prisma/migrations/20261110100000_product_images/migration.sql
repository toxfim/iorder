-- Product photos (owner 2026-10-29). The files are on disk (MEDIA_DIR); these rows are their
-- history. A photo is removed by marking it, never by deleting the row.
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL,
    "sha256" TEXT NOT NULL,
    "original_content_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "source_url" TEXT,
    "idempotency_key" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" TEXT,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_images_content_type_check"
        CHECK ("original_content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "product_images_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "product_images_size_check"
        CHECK ("width" > 0 AND "height" > 0 AND "byte_size" > 0),
    -- Removed means both who and when; a removed photo is never the primary one.
    CONSTRAINT "product_images_removed_check"
        CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL)),
    CONSTRAINT "product_images_removed_not_primary_check"
        CHECK ("removed_at" IS NULL OR NOT "is_primary")
);

CREATE INDEX "product_images_product_id_idx" ON "product_images"("product_id");
CREATE UNIQUE INDEX "product_images_uploaded_by_idempotency_key_key"
    ON "product_images"("uploaded_by", "idempotency_key");
-- One primary photo per product, and the same file only once per product (removed rows aside).
CREATE UNIQUE INDEX "product_images_one_primary_key"
    ON "product_images"("product_id") WHERE "is_primary" AND "removed_at" IS NULL;
CREATE UNIQUE INDEX "product_images_product_sha256_key"
    ON "product_images"("product_id", "sha256") WHERE "removed_at" IS NULL;

ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- History: only is_primary may change on a live photo, and removing is final.
CREATE FUNCTION product_images_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'product image % may not be deleted', OLD.id;
    END IF;
    IF OLD.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'product image % is removed', OLD.id;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.product_id IS DISTINCT FROM OLD.product_id
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

CREATE TRIGGER product_images_guard
    BEFORE UPDATE OR DELETE ON "product_images"
    FOR EACH ROW EXECUTE FUNCTION product_images_guard();
