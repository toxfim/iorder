-- The exact link between a history event and the messages it produced. Before this column the
-- timeline guessed the pairing from the message type and the timestamp. Rows written before this
-- migration keep a NULL link and are simply shown without a notification marker.
ALTER TABLE "notification_outbox" ADD COLUMN "order_event_id" UUID;

ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_order_event_id_fkey" FOREIGN KEY ("order_event_id") REFERENCES "order_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "notification_outbox_order_event_id_idx" ON "notification_outbox"("order_event_id");

-- The link is set at INSERT only: the guard now rejects a change of it like every other column
-- except status, attempts and sent_at. (The application role's UPDATE grant is unchanged.)
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
        RAISE EXCEPTION 'only status, attempts and sent_at of a notification may change'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'SENT' THEN
        RAISE EXCEPTION 'a sent notification is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
