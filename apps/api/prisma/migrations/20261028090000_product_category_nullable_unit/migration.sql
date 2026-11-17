-- Products can now be created from the sheet (data-model §6.4): the sheet has no unit, so the unit
-- is optional until staff set it. A product without a unit cannot be priced (checked in the
-- pricing service); a unit that is set must still be non-blank.
ALTER TABLE "products" ALTER COLUMN "unit" DROP NOT NULL;

ALTER TABLE "products"
    ADD CONSTRAINT "products_unit_not_blank" CHECK ("unit" IS NULL OR btrim("unit") <> '');

-- Staff-only category (from the latest delivery line). Trimmed, not blank, at most 200 characters
-- (the same limit as the sheet row validation).
ALTER TABLE "products" ADD COLUMN "category" TEXT;

ALTER TABLE "products"
    ADD CONSTRAINT "products_category_valid" CHECK (
        "category" IS NULL
        OR ("category" = btrim("category") AND "category" <> '' AND char_length("category") <= 200)
    );

CREATE INDEX "products_category_idx" ON "products" ("category");
