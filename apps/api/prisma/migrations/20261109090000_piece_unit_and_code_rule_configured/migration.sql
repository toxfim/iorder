-- Owner decision 2026-10-28: the company sells whole pieces only, so a product no longer needs a
-- unit before it can be priced. Existing values are kept (nothing is rewritten): a NULL unit of an
-- older sheet-created product simply means "piece" to the application, which no longer reads the
-- column. New rows get the canonical value 'PIECE'. Order snapshots (order_items.unit_snapshot)
-- are untouched.
ALTER TABLE "products" ALTER COLUMN "unit" SET DEFAULT 'PIECE';

-- The guard that refused pricing a product without a unit belongs to the dropped rule.
DROP TRIGGER IF EXISTS "price_list_items_unit_guard" ON "price_list_items";
DROP FUNCTION IF EXISTS price_list_items_unit_guard();

-- tracking_type defaults to NONE, so a stored NONE could not tell "never set" from "a person chose
-- no code". The flag records that someone (or a linked category template) set the rule; the staff
-- editor suggests the company rule only while it is false, and the sheet sync adopts only those.
ALTER TABLE "products" ADD COLUMN "code_rule_configured" BOOLEAN NOT NULL DEFAULT false;

-- Initial value derived from what is already known (no business value changes): a rule other than
-- the default, a linked template, or an audited rule change means it was set on purpose.
UPDATE "products" p
SET "code_rule_configured" = true
WHERE p."tracking_type" <> 'NONE'
   OR p."marking_required"
   OR p."category_id" IS NOT NULL
   OR EXISTS (
       SELECT 1 FROM "audit_log" a
       WHERE a."entity_type" = 'PRODUCT'
         AND a."entity_id" = p."id"::text
         AND a."action" IN ('PRODUCT_TRACKING_CHANGED', 'SHEET_SYNC_PRODUCT_TRACKING_LINKED')
   );
