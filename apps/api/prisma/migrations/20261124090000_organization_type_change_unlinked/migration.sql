-- Manager and admin may change an organization's type [C, owner 2026-11-12], but only while it has
-- no Telegram chat [P]: the bound chat (a group, or one person's private chat) is what the type
-- describes, so a linked organization keeps its type.
CREATE OR REPLACE FUNCTION organizations_type_frozen() RETURNS trigger AS $$
BEGIN
    IF NEW."type" IS DISTINCT FROM OLD."type"
        AND (OLD."telegram_chat_id" IS NOT NULL OR NEW."telegram_chat_id" IS NOT NULL) THEN
        RAISE EXCEPTION 'the type of a linked organization is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
