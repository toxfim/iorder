-- [C, owner 2026-11-13] Staff may "delete" an organization, but deleting is ARCHIVING only: orders,
-- payments, member history and notifications all reference organizations (ON DELETE RESTRICT) and
-- history is never deleted (hard rule 12). Only the admin archives and restores. No existing row
-- is archived, so both columns start NULL everywhere.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "archived_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_archived_by_user_id_fkey" FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: what Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

-- Who and when go together: an archive always records both, a restore clears both.
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_archived_pair"
    CHECK (("archived_at" IS NULL) = ("archived_by_user_id" IS NULL));

-- An archived organization can never be ACTIVE: nobody orders or is messaged through it until an
-- admin restores it and staff activate it again [P].
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_archived_is_inactive"
    CHECK ("archived_at" IS NULL OR "status" = 'INACTIVE');
