-- A NULL actor means "system action". Two systems may act: the sheet sync (SHEET_SYNC_*) and the
-- Central Bank rate refresh (RATE_REFRESH_*). Anything else must carry a real actor.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_required";

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_required"
    CHECK (
        "actor_user_id" IS NOT NULL
        OR left("action", 11) = 'SHEET_SYNC_'
        OR left("action", 13) = 'RATE_REFRESH_'
    );
