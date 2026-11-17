-- API tokens (owner 2026-10-29): a program (the bulk product photo upload) calls the api as a staff
-- member, limited to the scopes of its token. Issued and revoked only with the CLI.
CREATE TABLE "api_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_tokens_expiry_check" CHECK ("expires_at" > "created_at"),
    -- A token without a scope could do nothing; one is always required.
    CONSTRAINT "api_tokens_scopes_check" CHECK (cardinality("scopes") > 0),
    CONSTRAINT "api_tokens_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");

ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A revoked token stays revoked, and only the bookkeeping columns may ever change.
CREATE FUNCTION api_tokens_guard() RETURNS trigger AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'api token % is already revoked', OLD.id;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
        OR NEW.scopes IS DISTINCT FROM OLD.scopes
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'api token % may only change last_used_at and revoked_at', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER api_tokens_guard
    BEFORE UPDATE ON "api_tokens"
    FOR EACH ROW EXECUTE FUNCTION api_tokens_guard();

-- The CLI issues and revokes tokens without a signed-in person: a new system source `CLI_`.
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
        OR left("action", 11) = 'PRICE_POST_'
        OR left("action", 4) = 'CLI_'
    );
