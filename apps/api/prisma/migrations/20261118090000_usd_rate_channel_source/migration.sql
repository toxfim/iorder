-- [C, owner 2026-10-31] The rate in force can come from the Telegram channel, valid for its day like
-- a Central Bank rate. A published version's snapshot records that source; only a manual rate has no
-- date. Old rows keep their meaning: both constraints accept everything they accepted before.
ALTER TABLE "price_list_version_rates"
    DROP CONSTRAINT "price_list_version_rates_source_known",
    DROP CONSTRAINT "price_list_version_rates_date_matches_source",
    ADD CONSTRAINT "price_list_version_rates_source_known"
        CHECK ("source" IN ('CHANNEL', 'CBU', 'MANUAL')),
    ADD CONSTRAINT "price_list_version_rates_date_matches_source"
        CHECK (("source" = 'MANUAL') = ("rate_date" IS NULL));
