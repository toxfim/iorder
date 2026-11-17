-- A product without a unit (created from the sheet, data-model §6.4) can never be priced. The
-- pricing service checks this (PRODUCT_UNIT_MISSING); this trigger is the database-level guard
-- for raw SQL and for a future code path that forgets the check.
CREATE FUNCTION price_list_items_unit_guard() RETURNS trigger AS $$
DECLARE
    product_unit TEXT;
BEGIN
    SELECT "unit" INTO product_unit FROM "products" WHERE "id" = NEW."product_id";
    -- No row: the foreign key reports the missing product.
    IF FOUND AND product_unit IS NULL THEN
        RAISE EXCEPTION 'product % has no unit and cannot be priced', NEW."product_id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "price_list_items_unit_guard"
    BEFORE INSERT OR UPDATE ON "price_list_items"
    FOR EACH ROW EXECUTE FUNCTION price_list_items_unit_guard();
