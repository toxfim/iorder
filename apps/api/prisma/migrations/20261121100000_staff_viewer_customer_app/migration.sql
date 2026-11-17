-- Staff members may open the CUSTOMER app as viewers [C, owner 2026-11-09]: prices and a cart, no
-- organization. Two additive changes; no existing row changes its meaning.

-- 1. A website session opened by a staff member at the customer door is a VIEWER session: it never
--    carries staff powers, so a token held by the customer site cannot call a staff route. The flag
--    is fixed at creation (the guard below refuses to change it), like the method.
ALTER TABLE "staff_sessions" ADD COLUMN "staff_viewer" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION staff_sessions_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'staff_sessions rows are history and cannot be deleted';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
       OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
       OR NEW."method" IS DISTINCT FROM OLD."method"
       OR NEW."staff_viewer" IS DISTINCT FROM OLD."staff_viewer"
       OR NEW."user_agent" IS DISTINCT FROM OLD."user_agent"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
        RAISE EXCEPTION 'only last_seen_at and revoked_at of a staff session may change';
    END IF;
    IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
        RAISE EXCEPTION 'a revoked staff session cannot be changed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. A staff viewer's cart belongs to NO organization (staff are never organization members), so
--    the cart works in production where no staff order is possible. Customer carts keep their
--    organization: (user_id, organization_id) stays unique for them, and the partial index gives a
--    person at most one cart without an organization (NULLs are distinct in the first index).
ALTER TABLE "carts" ALTER COLUMN "organization_id" DROP NOT NULL;

CREATE UNIQUE INDEX "carts_user_id_without_organization_key"
    ON "carts"("user_id") WHERE "organization_id" IS NULL;
