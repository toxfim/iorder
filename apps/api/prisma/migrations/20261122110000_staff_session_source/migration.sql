-- Security review, 2026-11-10. A viewer session the customer site got through a handoff code comes
-- from one dashboard session and must not outlive it: the source is recorded, fixed at creation
-- like the method and the viewer flag, so a sign-out (or the end) of the dashboard session can take
-- its children with it. NULL for every session opened at a sign-in door.
ALTER TABLE "staff_sessions" ADD COLUMN "source_session_id" UUID;

ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_source_session_id_fkey"
    FOREIGN KEY ("source_session_id") REFERENCES "staff_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "staff_sessions_source_session_id_idx" ON "staff_sessions"("source_session_id")
    WHERE "source_session_id" IS NOT NULL;

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
       OR NEW."source_session_id" IS DISTINCT FROM OLD."source_session_id"
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

-- Handoff codes (migration staff_handoff_codes) are not history (the audit log is): a code that was
-- used, or that expired, more than a day ago may be removed. A fresh row still cannot be deleted.
CREATE OR REPLACE FUNCTION staff_handoff_codes_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."used_at" IS NULL AND OLD."expires_at" > now() - interval '1 day' THEN
            RAISE EXCEPTION 'a staff handoff code can be deleted only a day after it was used or expired';
        END IF;
        IF OLD."used_at" IS NOT NULL AND OLD."used_at" > now() - interval '1 day' THEN
            RAISE EXCEPTION 'a staff handoff code can be deleted only a day after it was used or expired';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."used_at" IS NOT NULL THEN
        RAISE EXCEPTION 'staff handoff code % is already used', OLD."id";
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
       OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
       OR NEW."code_hash" IS DISTINCT FROM OLD."code_hash"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
        RAISE EXCEPTION 'only used_at of a staff handoff code may change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
