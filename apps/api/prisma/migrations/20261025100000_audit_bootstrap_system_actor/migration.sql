-- A NULL actor means "system action". Three systems may act: the sheet sync (SHEET_SYNC_*), the
-- Central Bank rate refresh (RATE_REFRESH_*, introduced on the rate branch) and the one-off admin
-- bootstrap (BOOTSTRAP_*, `seed:admin`). Anything else must carry a real actor.
--
-- The constraint is rewritten as the UNION of all known sources, so it is correct whichever of
-- the branches that each add one source is merged first. IF EXISTS keeps the migration safe to
-- re-run after a partial failure (statements are not one transaction).
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_actor_required";

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_required"
    CHECK (
        "actor_user_id" IS NOT NULL
        OR left("action", 11) = 'SHEET_SYNC_'
        OR left("action", 13) = 'RATE_REFRESH_'
        OR left("action", 10) = 'BOOTSTRAP_'
    );
