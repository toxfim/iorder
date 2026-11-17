-- Staff website sessions and password sign-in (owner decision 2026-10-22: staff may sign in with
-- the Telegram Mini App, the Telegram Login Widget, or login + password).

-- 1. Credentials live in their own table (not in `users`) so no whole-user query can carry the hash.
CREATE TABLE "staff_credentials" (
    "user_id" UUID NOT NULL,
    "login" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "staff_credentials_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "staff_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Lowercase letters, digits, dot, underscore, hyphen; 3 to 32 characters; starts with a letter or digit.
    CONSTRAINT "staff_credentials_login_format" CHECK ("login" ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
    -- A versioned scrypt string: the application never stores anything else.
    CONSTRAINT "staff_credentials_hash_format" CHECK ("password_hash" ~ '^scrypt\$v1\$N=[0-9]+,r=[0-9]+,p=[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
    CONSTRAINT "staff_credentials_failed_attempts_nonneg" CHECK ("failed_attempts" >= 0)
);

CREATE UNIQUE INDEX "staff_credentials_login_key" ON "staff_credentials"("login");

-- 2. Sessions. Only the SHA-256 of the token is stored.
CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "staff_sessions_token_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "staff_sessions_method_known" CHECK ("method" IN ('TELEGRAM_WIDGET', 'PASSWORD')),
    CONSTRAINT "staff_sessions_user_agent_length" CHECK ("user_agent" IS NULL OR char_length("user_agent") <= 200),
    CONSTRAINT "staff_sessions_expires_after_creation" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "staff_sessions_token_hash_key" ON "staff_sessions"("token_hash");
CREATE INDEX "staff_sessions_user_id_idx" ON "staff_sessions"("user_id");

-- Session rows are history: never deleted, and only last_seen_at / revoked_at may change. A
-- revoked session stays revoked (the revocation time can be neither cleared nor moved).
CREATE FUNCTION staff_sessions_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'staff_sessions rows are history and cannot be deleted';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
       OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
       OR NEW."method" IS DISTINCT FROM OLD."method"
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

CREATE TRIGGER "staff_sessions_guard"
    BEFORE UPDATE OR DELETE ON "staff_sessions"
    FOR EACH ROW EXECUTE FUNCTION staff_sessions_guard();

CREATE TRIGGER "staff_sessions_no_truncate"
    BEFORE TRUNCATE ON "staff_sessions"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "staff_credentials_no_truncate"
    BEFORE TRUNCATE ON "staff_credentials"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- 3. A fifth system audit source: failed and rejected sign-ins (AUTH_*) have no authenticated
-- person. Rewritten as the UNION of all sources, like the earlier migrations of this constraint.
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
    );
