-- CreateEnum
CREATE TYPE "language" AS ENUM ('UZ', 'RU', 'EN');

-- CreateEnum
CREATE TYPE "price_list_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "price_list_source" AS ENUM ('MANUAL', 'SHEET_IMPORT');

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_translations" (
    "product_id" UUID NOT NULL,
    "lang" "language" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "product_translations_pkey" PRIMARY KEY ("product_id","lang")
);

-- CreateTable
CREATE TABLE "price_list_versions" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "status" "price_list_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "published_by" TEXT,
    "note" TEXT,
    "source" "price_list_source" NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_list_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_items" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "base_price" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',

    CONSTRAINT "price_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_created_at_idx" ON "audit_log"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_versions_number_key" ON "price_list_versions"("number");

-- CreateIndex
CREATE INDEX "price_list_items_product_id_idx" ON "price_list_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_items_version_id_product_id_key" ON "price_list_items"("version_id", "product_id");

-- AddForeignKey
ALTER TABLE "product_translations" ADD CONSTRAINT "product_translations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "price_list_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- Hand-written SQL: invariants Prisma cannot express (data-model §4 items 3 and 4).
-- The service layer enforces these first; the database is the last line of defence.
-- ---------------------------------------------------------------------------------------

-- Prices are positive; a draft/published row with a zero or negative price is a bug.
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_base_price_positive" CHECK ("base_price" > 0);

-- A DRAFT has no publication data; every other status has it.
ALTER TABLE "price_list_versions"
    ADD CONSTRAINT "price_list_versions_publication_data" CHECK (
        ("status" = 'DRAFT' AND "published_at" IS NULL AND "published_by" IS NULL)
        OR ("status" <> 'DRAFT' AND "published_at" IS NOT NULL AND "published_by" IS NOT NULL)
    );

-- Hard rule 5: at most one PUBLISHED version. (Zero is allowed only before the first publish.)
CREATE UNIQUE INDEX "price_list_versions_one_published"
    ON "price_list_versions" ((true)) WHERE "status" = 'PUBLISHED';

-- OPEN PRODUCT QUESTION: whether several DRAFTs may exist at once is not specified.
-- Restrictive choice: at most one open DRAFT. To allow more, drop this index and the
-- MAX_OPEN_DRAFTS check in the pricing service.
CREATE UNIQUE INDEX "price_list_versions_one_draft"
    ON "price_list_versions" ((true)) WHERE "status" = 'DRAFT';

-- Version lifecycle: DRAFT -> PUBLISHED -> ARCHIVED. A published version only changes
-- status (to ARCHIVED); an archived one never changes; only a DRAFT can be deleted.
CREATE FUNCTION price_list_versions_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'price list version % is % and cannot be deleted', OLD."id", OLD."status"
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."status" = 'ARCHIVED' THEN
        RAISE EXCEPTION 'archived price list version % is immutable', OLD."id"
            USING ERRCODE = 'restrict_violation';
    ELSIF OLD."status" = 'PUBLISHED' THEN
        IF NEW."status" <> 'ARCHIVED'
           OR (NEW."id", NEW."number", NEW."note", NEW."source", NEW."published_at", NEW."published_by", NEW."created_at")
              IS DISTINCT FROM
              (OLD."id", OLD."number", OLD."note", OLD."source", OLD."published_at", OLD."published_by", OLD."created_at")
        THEN
            RAISE EXCEPTION 'published price list version % is immutable (it can only be archived)', OLD."id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF NEW."status" = 'ARCHIVED' THEN
        RAISE EXCEPTION 'draft price list version % must be published before it is archived', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "price_list_versions_guard"
    BEFORE UPDATE OR DELETE ON "price_list_versions"
    FOR EACH ROW EXECUTE FUNCTION price_list_versions_guard();

-- Items may change only while their version is a DRAFT. FOR SHARE on the version row makes
-- a concurrent publish (which updates that row) wait for in-flight item edits, and the other
-- way round, so an item can never slip into a version that is being published.
CREATE FUNCTION price_list_items_guard() RETURNS trigger AS $$
DECLARE
    version_status "price_list_status";
BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT "status" INTO version_status FROM "price_list_versions"
            WHERE "id" = NEW."version_id" FOR SHARE;
        IF version_status IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'items of price list version % cannot change: version is not a draft', NEW."version_id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT "status" INTO version_status FROM "price_list_versions"
            WHERE "id" = OLD."version_id" FOR SHARE;
        -- No row: the draft itself is being deleted and this is the cascade. Deleting a
        -- non-draft version is rejected by price_list_versions_guard before it gets here.
        IF FOUND AND version_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'items of price list version % cannot change: version is not a draft', OLD."version_id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "price_list_items_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "price_list_items"
    FOR EACH ROW EXECUTE FUNCTION price_list_items_guard();

-- Hard rule 3 spirit for the audit trail: append-only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_no_update_delete"
    BEFORE UPDATE OR DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER "audit_log_no_truncate"
    BEFORE TRUNCATE ON "audit_log"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
