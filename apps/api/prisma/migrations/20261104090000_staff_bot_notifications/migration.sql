-- Staff bot notifications ([C] 2026-10-25): whether the bot can write to a person, and the
-- one-time links that connect the bot (and the Telegram id) for a staff member.
ALTER TABLE "users" ADD COLUMN "bot_started_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "bot_blocked_at" TIMESTAMPTZ(3);

CREATE TABLE "telegram_link_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_link_tokens_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "telegram_link_tokens_token_hash_key" ON "telegram_link_tokens"("token_hash");
CREATE INDEX "telegram_link_tokens_user_id_idx" ON "telegram_link_tokens"("user_id");

ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A used token stays used: once used_at is set it can never be cleared or changed.
CREATE FUNCTION telegram_link_tokens_keep_used() RETURNS trigger AS $$
BEGIN
    IF OLD.used_at IS NOT NULL THEN
        RAISE EXCEPTION 'telegram link token % is already used', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER telegram_link_tokens_keep_used
    BEFORE UPDATE ON "telegram_link_tokens"
    FOR EACH ROW EXECUTE FUNCTION telegram_link_tokens_keep_used();
