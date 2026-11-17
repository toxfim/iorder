-- When the last wrong password was counted. Lets the failure counter decay after a quiet period, so
-- a stranger cannot keep a login locked forever with one guess per lock (review finding).
ALTER TABLE "staff_credentials" ADD COLUMN "last_failed_at" TIMESTAMPTZ(3);
