-- Who added the bot to a Telegram group. An organization created by the bot starts INACTIVE and
-- staff decide whether to activate it, so they need to see who brought the bot in. Both columns
-- are NULL for organizations that were not created from a group event.
ALTER TABLE "organizations"
    ADD COLUMN "added_by_telegram_user_id" BIGINT,
    ADD COLUMN "added_by_name" TEXT;

ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_added_by_telegram_user_id_positive"
    CHECK ("added_by_telegram_user_id" IS NULL OR "added_by_telegram_user_id" > 0),
    ADD CONSTRAINT "organizations_added_by_name_length"
    CHECK ("added_by_name" IS NULL OR char_length("added_by_name") <= 200);
