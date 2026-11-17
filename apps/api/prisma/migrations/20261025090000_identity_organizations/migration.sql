-- Identity and organizations (data-model.md, Identity and organizations; invariants 9 and 10).

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'BLOCKED');
CREATE TYPE "staff_role" AS ENUM ('ADMIN', 'MANAGER', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER');
CREATE TYPE "organization_status" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "organization_role" AS ENUM ('SHOP_OWNER', 'SELLER');
CREATE TYPE "member_status" AS ENUM ('ACTIVE', 'LEFT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "language" "language" NOT NULL DEFAULT 'UZ',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    -- Telegram user ids are positive integers; a stray 0 or negative id is a bug, not a user.
    CONSTRAINT "users_telegram_user_id_positive" CHECK ("telegram_user_id" > 0),
    CONSTRAINT "users_full_name_not_blank" CHECK (btrim("full_name") <> '')
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role" "staff_role" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "status" "organization_status" NOT NULL DEFAULT 'ACTIVE',
    "price_posting_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizations_name_not_blank" CHECK (btrim("name") <> '')
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "organization_role" NOT NULL,
    "status" "member_status" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "left_at" TIMESTAMPTZ(3),

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_members_left_at_matches_status"
        CHECK (("status" = 'LEFT') = ("left_at" IS NOT NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");
CREATE UNIQUE INDEX "organizations_telegram_chat_id_key" ON "organizations"("telegram_chat_id");
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key"
    ON "organization_members"("organization_id", "user_id");

-- A user has at most one ACTIVE membership (current rule; relax by dropping this index only).
CREATE UNIQUE INDEX "organization_members_one_active_per_user"
    ON "organization_members"("user_id") WHERE "status" = 'ACTIVE';
-- An organization has at most one ACTIVE shop owner.
CREATE UNIQUE INDEX "organization_members_one_active_owner_per_organization"
    ON "organization_members"("organization_id")
    WHERE "status" = 'ACTIVE' AND "role" = 'SHOP_OWNER';

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Staff are never organization members (invariant 9, confirmed). Enforced in BOTH directions.
-- Each trigger first takes a row lock on the user, so a concurrent "add role" and "add
-- membership" for the same person serialize: whichever commits second sees the other and fails.
-- (FOR NO KEY UPDATE conflicts with itself but not with the FOR KEY SHARE that foreign keys take.)
CREATE FUNCTION "guard_staff_role_has_no_membership"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM "users" WHERE "id" = NEW."user_id" FOR NO KEY UPDATE;
    IF EXISTS (
        SELECT 1 FROM "organization_members"
        WHERE "user_id" = NEW."user_id" AND "status" = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'staff_role_conflicts_with_membership: user has an ACTIVE organization membership'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "user_roles_no_membership"
    BEFORE INSERT OR UPDATE ON "user_roles"
    FOR EACH ROW EXECUTE FUNCTION "guard_staff_role_has_no_membership"();

CREATE FUNCTION "guard_membership_of_staff"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- A LEFT row is history, so only an ACTIVE membership is refused.
    IF NEW."status" = 'ACTIVE' THEN
        PERFORM 1 FROM "users" WHERE "id" = NEW."user_id" FOR NO KEY UPDATE;
        IF EXISTS (SELECT 1 FROM "user_roles" WHERE "user_id" = NEW."user_id") THEN
            RAISE EXCEPTION 'membership_conflicts_with_staff_role: user holds a staff role'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "organization_members_no_staff"
    BEFORE INSERT OR UPDATE ON "organization_members"
    FOR EACH ROW EXECUTE FUNCTION "guard_membership_of_staff"();
