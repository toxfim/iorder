-- One row per sheet sync run (STAFF-ONLY report history). Holds no cost values and no other cell
-- contents: rejected rows name a header and a reason, mismatches only a percentage. The only
-- sheet text kept is the (capped) supplier name of skipped rows, which is staff-only.
CREATE TYPE "sheet_sync_run_status" AS ENUM ('OK', 'FAILED');
CREATE TYPE "sheet_sync_trigger" AS ENUM ('MANUAL', 'SCHEDULED');

CREATE TABLE "sheet_sync_runs" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "sheet_sync_run_status" NOT NULL,
    "trigger" "sheet_sync_trigger" NOT NULL,
    "counts" JSONB NOT NULL,
    "rejected_rows" JSONB NOT NULL,
    "skipped_suppliers" JSONB NOT NULL,
    "created_products" JSONB NOT NULL,
    "pending_removal_requests" INTEGER NOT NULL,
    "cost_mismatches" JSONB NOT NULL,
    "error_code" TEXT,

    CONSTRAINT "sheet_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sheet_sync_runs_started_at_idx" ON "sheet_sync_runs" ("started_at");

ALTER TABLE "sheet_sync_runs"
    ADD CONSTRAINT "sheet_sync_runs_times_ordered" CHECK ("finished_at" >= "started_at"),
    ADD CONSTRAINT "sheet_sync_runs_error_code_matches_status"
        CHECK (("status" = 'FAILED') = ("error_code" IS NOT NULL)),
    ADD CONSTRAINT "sheet_sync_runs_pending_removals_nonnegative"
        CHECK ("pending_removal_requests" >= 0),
    ADD CONSTRAINT "sheet_sync_runs_json_shapes" CHECK (
        jsonb_typeof("counts") = 'object'
        AND jsonb_typeof("rejected_rows") = 'array'
        AND jsonb_typeof("skipped_suppliers") = 'array'
        AND jsonb_typeof("created_products") = 'array'
        AND jsonb_typeof("cost_mismatches") = 'array'
    );

-- Rows are only inserted, and the oldest are pruned (DELETE); the whole table is never emptied.
CREATE TRIGGER "sheet_sync_runs_no_truncate"
    BEFORE TRUNCATE ON "sheet_sync_runs"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
