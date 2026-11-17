-- Owner 2026-10-29: a product has a sale price ("Цена $") and a deferred-payment price
-- ("Отсрочка $", pay in parts), both entered in USD. The second column was added as a "cash"
-- price by mistake; it is the deferred price. New items are stored in USD; the UZS amount is
-- derived from the USD rate when the list is read. Existing rows keep their own currency.
ALTER TABLE "price_list_items" RENAME COLUMN "cash_price" TO "deferred_price";
ALTER TABLE "price_list_items"
    RENAME CONSTRAINT "price_list_items_cash_price_positive" TO "price_list_items_deferred_price_positive";
ALTER TABLE "price_list_items" ALTER COLUMN "currency" SET DEFAULT 'USD';
-- Customers still see UZS (hard rule 1): the conversion happens before any customer response.
ALTER TABLE "price_list_items" DROP CONSTRAINT "price_list_items_currency_uzs";
ALTER TABLE "price_list_items"
    ADD CONSTRAINT "price_list_items_currency_known" CHECK ("currency" IN ('USD', 'UZS'));
