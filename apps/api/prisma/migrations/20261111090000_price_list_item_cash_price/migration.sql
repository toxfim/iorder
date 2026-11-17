-- Two prices per product (owner 2026-10-28): the base price is the official one, the optional
-- cash ("Naqd") price is used for cash orders. Null = the official price applies to cash too.
ALTER TABLE "price_list_items" ADD COLUMN "cash_price" DECIMAL(18,2);

ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_cash_price_positive"
    CHECK ("cash_price" IS NULL OR "cash_price" > 0);
