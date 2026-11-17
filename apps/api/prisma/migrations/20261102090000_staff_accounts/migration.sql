-- Staff accounts created by a manager or admin (owner request 2026-10-22): the login looks like an
-- email address, and a staff member may exist before their Telegram account is linked.

-- 1. Login format. Two shapes are valid. The legacy shape (3-32 characters of a-z 0-9 . _ -) stays
-- so rows stored earlier remain valid. The new email-like shape is `local@domain.tld`: lowercase
-- ASCII, the local part starts and ends with a letter or digit, domain labels do not start or end
-- with a hyphen, the last label is letters only, no consecutive dots, at most 64 characters.
-- It is an identifier only: no email is ever sent. Mirrors isStaffLogin in packages/shared.
ALTER TABLE "staff_credentials" DROP CONSTRAINT "staff_credentials_login_format";
ALTER TABLE "staff_credentials"
    ADD CONSTRAINT "staff_credentials_login_format" CHECK (
        "login" ~ '^[a-z0-9][a-z0-9._-]{2,31}$'
        OR (
            char_length("login") <= 64
            AND "login" !~ '\.\.'
            AND "login" ~ '^[a-z0-9]([a-z0-9._+-]*[a-z0-9])?@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
        )
    );

-- 2. A staff account may exist without a Telegram id until it is linked. The column stays UNIQUE
-- (several NULLs are allowed by PostgreSQL). Customers and organization members always have one.
ALTER TABLE "users" ALTER COLUMN "telegram_user_id" DROP NOT NULL;

-- A user with no Telegram id must hold a staff role. This spans two tables, so it is a constraint
-- trigger checked at COMMIT: a staff account is created as the user row plus its role rows in one
-- transaction. Customers (no role) therefore always have a Telegram id, and a staff member without
-- one cannot lose their last role.
CREATE FUNCTION "guard_telegram_id_required_without_staff_role"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    subject UUID;
BEGIN
    -- Separate branches: PL/pgSQL fails on a record field the firing table does not have.
    IF TG_TABLE_NAME = 'users' THEN
        subject := NEW."id";
    ELSE
        subject := OLD."user_id";
    END IF;
    IF EXISTS (SELECT 1 FROM "users" WHERE "id" = subject AND "telegram_user_id" IS NULL)
       AND NOT EXISTS (SELECT 1 FROM "user_roles" WHERE "user_id" = subject) THEN
        RAISE EXCEPTION 'telegram_id_required: only a staff member may have no Telegram id'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "users_telegram_id_required"
    AFTER INSERT OR UPDATE OF "telegram_user_id" ON "users"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "guard_telegram_id_required_without_staff_role"();

CREATE CONSTRAINT TRIGGER "user_roles_telegram_id_required"
    AFTER DELETE ON "user_roles"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "guard_telegram_id_required_without_staff_role"();

-- An ACTIVE membership additionally needs a Telegram id (immediate check, same lock as before).
CREATE OR REPLACE FUNCTION "guard_membership_of_staff"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- A LEFT row is history, so only an ACTIVE membership is refused.
    IF NEW."status" = 'ACTIVE' THEN
        PERFORM 1 FROM "users" WHERE "id" = NEW."user_id" FOR NO KEY UPDATE;
        IF EXISTS (SELECT 1 FROM "user_roles" WHERE "user_id" = NEW."user_id") THEN
            RAISE EXCEPTION 'membership_conflicts_with_staff_role: user holds a staff role'
                USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "telegram_user_id" IS NULL) THEN
            RAISE EXCEPTION 'telegram_id_required: a member needs a Telegram id'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
