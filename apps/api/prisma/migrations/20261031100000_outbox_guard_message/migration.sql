-- The guard already lets the delivery bookkeeping columns added by telegram_bot_support change (it
-- only freezes the columns it lists), but its error message still said that only status, attempts
-- and sent_at may change. Same rules, current message.
CREATE OR REPLACE FUNCTION notification_outbox_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification_outbox rows are kept (DELETE rejected)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."recipient_kind" IS DISTINCT FROM OLD."recipient_kind"
       OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
       OR NEW."recipient_role" IS DISTINCT FROM OLD."recipient_role"
       OR NEW."recipient_organization_id" IS DISTINCT FROM OLD."recipient_organization_id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."order_event_id" IS DISTINCT FROM OLD."order_event_id"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'only the delivery bookkeeping of a notification may change (status, attempts, sent_at, next_attempt_at, last_error_code, delivered_chat_ids)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'SENT' THEN
        RAISE EXCEPTION 'a sent notification is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
