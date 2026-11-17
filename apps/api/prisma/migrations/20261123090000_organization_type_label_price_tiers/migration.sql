-- Owner 2026-11-11 [C]: an organization has a TYPE (a Telegram group, or one person in a private
-- chat with the bot) and a LABEL (standard / wholesale / partner); the price list has two TIERS
-- (standard, and one shared by wholesale and partner). Staff create organizations from the staff app
-- and bind the chat through a one-time bot link [P]. Every existing organization is a GROUP with
-- the STANDARD label, every existing price is the STANDARD tier and every existing order was priced
-- with it: the column defaults below say exactly that, so no row is rewritten by hand.

-- CreateEnum
CREATE TYPE "organization_type" AS ENUM ('GROUP', 'PERSON');

-- CreateEnum
CREATE TYPE "organization_label" AS ENUM ('STANDARD', 'WHOLESALE', 'PARTNER');

-- CreateEnum
CREATE TYPE "price_tier" AS ENUM ('STANDARD', 'WHOLESALE_PARTNER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "price_tier" "price_tier" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "created_by_user_id" UUID,
ADD COLUMN     "label" "organization_label" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "merged_into_organization_id" UUID,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "type" "organization_type" NOT NULL DEFAULT 'GROUP',
ALTER COLUMN "telegram_chat_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "price_list_items" ADD COLUMN     "wholesale_deferred_price" DECIMAL(18,2),
ADD COLUMN     "wholesale_price" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "organization_invites" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_by_telegram_user_id" BIGINT,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_invites_token_key" ON "organization_invites"("token");

-- CreateIndex
CREATE INDEX "organization_invites_organization_id_idx" ON "organization_invites"("organization_id");

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: what Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

-- An organization without a chat (a staff-created one waiting for its invite) can reach nobody, so
-- it can never be ACTIVE.
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_chatless_is_inactive"
    CHECK ("telegram_chat_id" IS NOT NULL OR "status" = 'INACTIVE');

-- Telegram group ids are negative; a private chat id is the person's (positive) user id. NOT VALID:
-- new and changed rows are checked, existing rows are left as they are (they are all groups).
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_chat_matches_type"
    CHECK ("telegram_chat_id" IS NULL OR (("type" = 'PERSON') = ("telegram_chat_id" > 0))) NOT VALID;

ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_phone_format"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');

-- The type is what the organization IS; it never changes after creation.
CREATE FUNCTION organizations_type_frozen() RETURNS trigger AS $$
BEGIN
    IF NEW."type" IS DISTINCT FROM OLD."type" THEN
        RAISE EXCEPTION 'the organization type is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organizations_type_frozen_guard"
    BEFORE UPDATE ON "organizations"
    FOR EACH ROW EXECUTE FUNCTION organizations_type_frozen();

-- The wholesale tier's prices, like the standard ones: positive, and no deferred price without a
-- sale price. (The triggers that freeze the items of a published version guard the whole row.)
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_wholesale_price_positive"
    CHECK ("wholesale_price" IS NULL OR "wholesale_price" > 0);
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_wholesale_deferred_price_positive"
    CHECK ("wholesale_deferred_price" IS NULL OR "wholesale_deferred_price" > 0);
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_wholesale_deferred_needs_price"
    CHECK ("wholesale_deferred_price" IS NULL OR "wholesale_price" IS NOT NULL);

-- At most one open invite per organization: a regenerated link revokes the previous one first.
CREATE UNIQUE INDEX "organization_invites_one_open"
    ON "organization_invites"("organization_id")
    WHERE "used_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "organization_invites"
    ADD CONSTRAINT "organization_invites_token_format"
    CHECK ("token" ~ '^[A-Za-z0-9_-]{43}$');
ALTER TABLE "organization_invites"
    ADD CONSTRAINT "organization_invites_expiry_after_creation"
    CHECK ("expires_at" > "created_at");
ALTER TABLE "organization_invites"
    ADD CONSTRAINT "organization_invites_used_by_with_used_at"
    CHECK (("used_at" IS NULL) = ("used_by_telegram_user_id" IS NULL));

-- An invite is history: never deleted; only its use or its revocation is recorded, once.
CREATE FUNCTION organization_invites_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'organization_invites rows are history and cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."token" IS DISTINCT FROM OLD."token"
       OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
        RAISE EXCEPTION 'only the use or the revocation of an invite may be recorded'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."used_at" IS NOT NULL OR OLD."revoked_at" IS NOT NULL THEN
        RAISE EXCEPTION 'a used or revoked invite cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organization_invites_guard_update"
    BEFORE UPDATE OR DELETE ON "organization_invites"
    FOR EACH ROW EXECUTE FUNCTION organization_invites_guard();

CREATE TRIGGER "organization_invites_no_truncate"
    BEFORE TRUNCATE ON "organization_invites"
    FOR EACH STATEMENT EXECUTE FUNCTION organization_invites_guard();

-- The order's price tier is part of its identity (hard rule 4): a later label change never alters
-- an existing order. Same function as orders_core, plus "price_tier".
CREATE OR REPLACE FUNCTION orders_identity_frozen() RETURNS trigger AS $$
BEGIN
    IF NEW."order_number" IS DISTINCT FROM OLD."order_number"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."placed_by_user_id" IS DISTINCT FROM OLD."placed_by_user_id"
       OR NEW."price_list_version_id" IS DISTINCT FROM OLD."price_list_version_id"
       OR NEW."price_tier" IS DISTINCT FROM OLD."price_tier"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
       OR NEW."currency" IS DISTINCT FROM OLD."currency" THEN
        RAISE EXCEPTION 'order identity columns are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- The total only changes together with the content (row_version moves), never silently.
    IF NEW."total_amount" IS DISTINCT FROM OLD."total_amount"
       AND NEW."row_version" = OLD."row_version" THEN
        RAISE EXCEPTION 'the order total can only change together with row_version'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."row_version" < OLD."row_version" THEN
        RAISE EXCEPTION 'row_version cannot go back' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
