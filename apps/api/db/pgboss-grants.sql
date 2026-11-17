-- iOrder.uz: what the WORKER's application role needs on the pg-boss schema (ADR-001 §3.4).
--
-- Separate from app-role-grants.sql on purpose: the `pgboss` schema does not exist until
-- `pnpm --filter @iorder/api jobs:migrate` has created it (as the MIGRATOR / owner role, never as
-- the application role), and this file must run AFTER that. Run it as the same migrator, after
-- `jobs:migrate` and after every pg-boss upgrade:
--
--     psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -v app_role=iorder_app -v jobs_schema=pgboss \
--          -f apps/api/db/pgboss-grants.sql
--
-- The worker connects with `migrate: false, createSchema: false, reindex: false`, so it needs only
-- DML: it reads and writes job rows, schedules and queue settings, and calls pg-boss' own
-- functions. It owns nothing, creates no table (queues are created by `jobs:migrate`) and cannot
-- change or drop the schema. Idempotent.
--
-- Not granted: CREATE on the schema, TRUNCATE, TRIGGER, REFERENCES. The default-privileges line
-- covers tables the migrator creates later (a new queue's partition) for this role.

GRANT USAGE ON SCHEMA :"jobs_schema" TO :"app_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA :"jobs_schema" TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA :"jobs_schema" TO :"app_role";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA :"jobs_schema" TO :"app_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA :"jobs_schema"
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA :"jobs_schema"
    GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA :"jobs_schema"
    GRANT EXECUTE ON FUNCTIONS TO :"app_role";
