-- Cost pending delivery lines (2026-11-06). A fresh delivery is written into the «Поставка» sheet
-- with its quantities first; «Цена закупа $», «Курс на день поставки» and «Цена закупа сумм» are
-- typed later. Until now such a row was rejected as a whole, so its «Доступное кол-во» never
-- reached the stock aggregate (staging, delivery 7347: 35 lines, every one with stock, none
-- counted). The three cost columns may now be NULL, always together: the line counts for stock
-- at once and the sync fills the costs in when the cells are typed. The existing checks
-- (cost >= 0, rate > 0) keep holding for non-null values.

ALTER TABLE "price_reference"
    ALTER COLUMN "cost_usd" DROP NOT NULL,
    ALTER COLUMN "usd_rate_used" DROP NOT NULL,
    ALTER COLUMN "cost_uzs" DROP NOT NULL,
    ADD CONSTRAINT "price_reference_cost_all_or_none"
        CHECK (("cost_usd" IS NULL) = ("usd_rate_used" IS NULL)
           AND ("cost_usd" IS NULL) = ("cost_uzs" IS NULL));
