-- A NULL actor means "system action". Only the sheet sync is one, and its actions are named
-- SHEET_SYNC_*. Anything else must carry a real actor, so a bug (or a caller that "forgets" the
-- actor) cannot write anonymous history.
ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_required"
    CHECK ("actor_user_id" IS NOT NULL OR left("action", 11) = 'SHEET_SYNC_');
