-- Telegram bot support: a fourth system audit source, the outbox delivery bookkeeping and the
-- ordering guard of group events.

-- 1. A NULL audit actor means "system action". Sources: the sheet sync (SHEET_SYNC_*), the
-- Central Bank rate refresh (RATE_REFRESH_*), the one-off admin bootstrap (BOOTSTRAP_*) and now
-- the Telegram bot (TELEGRAM_*: organizations and members created from group events). Rewritten
-- as the UNION of all sources, like the earlier migrations of this constraint.
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_actor_required";

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_required"
    CHECK (
        "actor_user_id" IS NOT NULL
        OR left("action", 11) = 'SHEET_SYNC_'
        OR left("action", 13) = 'RATE_REFRESH_'
        OR left("action", 10) = 'BOOTSTRAP_'
        OR left("action", 9) = 'TELEGRAM_'
    );

-- 2. Outbox delivery bookkeeping. The sender updates ONLY these columns, `status`, `attempts`
-- and `sent_at` (column-level grant in db/app-role-grants.sql; the guard trigger already freezes
-- every other column of the row and makes SENT final).
--   next_attempt_at     NULL = due now. Set to the retry time after a failure and to the lease end
--                       while a worker is sending (a crashed worker's row becomes due again).
--   last_error_code     a short code of the last failure (never a message text or an error body).
--   delivered_chat_ids  chats this row was already delivered to (ROLE rows fan out to several
--                       people); a retry skips them, so one person is not messaged twice.
ALTER TABLE "notification_outbox"
    ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3),
    ADD COLUMN "last_error_code" TEXT,
    ADD COLUMN "delivered_chat_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_last_error_code_format"
    CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z_]{0,39}$');

-- The dispatcher's claim query reads only PENDING rows that are due.
CREATE INDEX "notification_outbox_pending_due_idx"
    ON "notification_outbox" ("next_attempt_at", "created_at")
    WHERE "status" = 'PENDING';

-- 3. Ordering guard for Telegram group events (they can be retried or arrive out of order): the
-- Telegram time of the last event that changed the organization's status. An older event is
-- ignored. NULL = never changed by Telegram.
ALTER TABLE "organizations" ADD COLUMN "telegram_status_event_at" TIMESTAMPTZ(3);
