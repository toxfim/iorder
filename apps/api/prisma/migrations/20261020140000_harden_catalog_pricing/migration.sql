-- Hand-written hardening on top of 20261020111825_catalog_pricing_audit (that migration is
-- already applied and is not edited).
--
-- Honest scope: triggers stop application mistakes and a role without ownership. They do NOT
-- stop the table owner or a superuser, who can DISABLE TRIGGER or SET session_replication_role.
-- The real protection is running the application as a non-owner role with DML-only grants
-- (see test/support/global-setup.ts for the shape and the integration test that proves it).

-- TRUNCATE does not fire row triggers, so it needs its own statement-level guard. The same
-- function is reused for every protected table; the reason is in the message.
CREATE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'TRUNCATE of % is not allowed', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "price_list_items_no_truncate"
    BEFORE TRUNCATE ON "price_list_items"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "price_list_versions_no_truncate"
    BEFORE TRUNCATE ON "price_list_versions"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "products_no_truncate"
    BEFORE TRUNCATE ON "products"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER "product_translations_no_truncate"
    BEFORE TRUNCATE ON "product_translations"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- Currency shown to customers is UZS (hard rule 1). A new currency needs a deliberate migration.
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_currency_uzs" CHECK ("currency" = 'UZS');

-- An item for a version that does not exist used to surface as a misleading "not a draft"
-- restrict_violation. Say what is wrong, with the foreign-key error class.
CREATE OR REPLACE FUNCTION price_list_items_guard() RETURNS trigger AS $$
DECLARE
    version_status "price_list_status";
BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT "status" INTO version_status FROM "price_list_versions"
            WHERE "id" = NEW."version_id" FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'price list version % does not exist', NEW."version_id"
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF version_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'items of price list version % cannot change: version is not a draft', NEW."version_id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT "status" INTO version_status FROM "price_list_versions"
            WHERE "id" = OLD."version_id" FOR SHARE;
        -- No row: the draft itself is being deleted and this is the cascade. Deleting a
        -- non-draft version is rejected by price_list_versions_guard before it gets here.
        IF FOUND AND version_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'items of price list version % cannot change: version is not a draft', OLD."version_id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
