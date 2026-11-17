-- The USD rate in force at publish time, copied onto the published version (data-model §6.3).
-- Staff-only, cost-class: kept in its own table so the customer-facing price_list_versions table
-- carries no cost-like column. A version without a row was published before any rate existed.

CREATE TABLE "price_list_version_rates" (
    "version_id" UUID NOT NULL,
    "usd_rate" DECIMAL(18,4) NOT NULL,
    "source" TEXT NOT NULL,
    "rate_date" DATE,

    CONSTRAINT "price_list_version_rates_pkey" PRIMARY KEY ("version_id")
);

ALTER TABLE "price_list_version_rates"
    ADD CONSTRAINT "price_list_version_rates_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "price_list_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "price_list_version_rates"
    ADD CONSTRAINT "price_list_version_rates_rate_positive" CHECK ("usd_rate" > 0),
    ADD CONSTRAINT "price_list_version_rates_source_known" CHECK ("source" IN ('CBU', 'MANUAL')),
    -- A Central Bank rate is valid for a day; a manual rate has none.
    ADD CONSTRAINT "price_list_version_rates_date_matches_source"
        CHECK (("source" = 'CBU') = ("rate_date" IS NOT NULL));

-- The snapshot belongs to the version it was taken for and can change only while that version is
-- still a DRAFT, i.e. in the transaction that publishes it. FOR SHARE makes a concurrent publish
-- wait for an in-flight snapshot write, like the items guard.
CREATE FUNCTION price_list_version_rates_guard() RETURNS trigger AS $$
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
            RAISE EXCEPTION 'the rate snapshot of price list version % cannot change: version is not a draft', NEW."version_id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT "status" INTO version_status FROM "price_list_versions"
            WHERE "id" = OLD."version_id" FOR SHARE;
        -- No row: the draft itself is being deleted and this is the cascade.
        IF FOUND AND version_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'the rate snapshot of price list version % cannot change: version is not a draft', OLD."version_id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "price_list_version_rates_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "price_list_version_rates"
    FOR EACH ROW EXECUTE FUNCTION price_list_version_rates_guard();

CREATE TRIGGER "price_list_version_rates_no_truncate"
    BEFORE TRUNCATE ON "price_list_version_rates"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
