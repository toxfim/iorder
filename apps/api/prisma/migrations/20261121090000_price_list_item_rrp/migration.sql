-- Owner 2026-11-09: a product may have a recommended retail price ("RRP"), what a shop may sell one
-- piece for. It sits next to the sale and the deferred price of a price list item, in the item's
-- own currency, and is versioned with them (the triggers that freeze the items of a published
-- version guard the whole row, so they cover this column too). Customers see it; it is never what
-- an order costs, so no order table gets a column. Null = none set.
ALTER TABLE "price_list_items" ADD COLUMN "rrp" DECIMAL(18,2);

ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_rrp_positive"
    CHECK ("rrp" IS NULL OR "rrp" > 0);
