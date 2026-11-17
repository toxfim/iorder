-- Staff continue on the customer site with their dashboard sign-in [C, owner 2026-11-09]. The two
-- sites are different origins, so the dashboard asks for a one-time code and the customer site
-- exchanges it for a VIEWER session. A code is 256 random bits, kept only as its SHA-256, lives
-- about a minute, works once, and belongs to the staff session that asked for it.
CREATE TABLE "staff_handoff_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "staff_handoff_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_handoff_codes_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "staff_handoff_codes_code_hash_key" ON "staff_handoff_codes"("code_hash");
CREATE INDEX "staff_handoff_codes_user_id_idx" ON "staff_handoff_codes"("user_id");
CREATE INDEX "staff_handoff_codes_session_id_idx" ON "staff_handoff_codes"("session_id");

ALTER TABLE "staff_handoff_codes" ADD CONSTRAINT "staff_handoff_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_handoff_codes" ADD CONSTRAINT "staff_handoff_codes_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "staff_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A code is used once: `used_at` is the only column that may change, and only from NULL. Rows
-- are never deleted (the application role has no DELETE either), so a used code stays used.
CREATE FUNCTION staff_handoff_codes_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'staff_handoff_codes rows cannot be deleted';
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

CREATE TRIGGER staff_handoff_codes_guard
    BEFORE UPDATE OR DELETE ON "staff_handoff_codes"
    FOR EACH ROW EXECUTE FUNCTION staff_handoff_codes_guard();
