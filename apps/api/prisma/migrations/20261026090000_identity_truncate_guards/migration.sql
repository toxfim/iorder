-- TRUNCATE does not fire row triggers; reuse the guard from the hardening migration so the
-- identity tables cannot be emptied by accident (this also stops a CASCADE from other tables).
CREATE TRIGGER "users_no_truncate"
    BEFORE TRUNCATE ON "users"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "user_roles_no_truncate"
    BEFORE TRUNCATE ON "user_roles"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "organizations_no_truncate"
    BEFORE TRUNCATE ON "organizations"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "organization_members_no_truncate"
    BEFORE TRUNCATE ON "organization_members"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
