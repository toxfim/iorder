-- Credential scopes ([C] 2026-10-28): staff logins and customer logins are separate namespaces.
-- Before, one unique login column served both, so a customer setting their own login learned
-- whether a staff login existed ("already taken"). Now the same login may exist once per scope,
-- and each public sign-in endpoint looks only in its own scope.

CREATE TYPE "credential_scope" AS ENUM ('STAFF', 'CUSTOMER');

ALTER TABLE "staff_credentials" ADD COLUMN "scope" "credential_scope";

-- Existing rows: a person with a staff role holds a staff login, everyone else a customer login.
UPDATE "staff_credentials" AS c
SET "scope" = CASE
    WHEN EXISTS (SELECT 1 FROM "user_roles" AS r WHERE r.user_id = c.user_id) THEN 'STAFF'::"credential_scope"
    ELSE 'CUSTOMER'::"credential_scope"
END;

ALTER TABLE "staff_credentials" ALTER COLUMN "scope" SET NOT NULL;

DROP INDEX "staff_credentials_login_key";
CREATE UNIQUE INDEX "staff_credentials_scope_login_key" ON "staff_credentials"("scope", "login");
