-- A delivery line with its USD and so'm costs but no «Курс на день поставки» (owner 2026-11-17):
-- in the real sheet many OMEGA Electronics lines are written that way, and they were rejected as a
-- whole, so their stock never counted. Such a line is now stored with a NULL rate; staff see its
-- so'm cost. USD and so'm stay together (both or neither), and a rate without costs is still
-- impossible. The checks cost >= 0 and rate > 0 keep holding for non-null values.

ALTER TABLE "price_reference"
    DROP CONSTRAINT "price_reference_cost_all_or_none",
    ADD CONSTRAINT "price_reference_cost_all_or_none"
        CHECK (("cost_usd" IS NULL) = ("cost_uzs" IS NULL)
           AND ("usd_rate_used" IS NULL OR "cost_usd" IS NOT NULL));
