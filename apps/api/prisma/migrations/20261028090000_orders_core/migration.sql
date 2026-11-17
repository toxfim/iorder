-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('UNPAID', 'PAID');

-- CreateEnum
CREATE TYPE "accounting_mode" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED_BY_MANAGER');

-- CreateEnum
CREATE TYPE "order_event_type" AS ENUM ('SUBMITTED', 'STATUS_CHANGED', 'ITEMS_EDITED', 'PAYMENT_STATUS_CHANGED', 'DRIVER_ASSIGNED', 'ACCOUNTING_SKIPPED', 'ACCOUNTING_REVIEWED', 'COMMENT_ADDED');

-- CreateEnum
CREATE TYPE "notification_recipient_kind" AS ENUM ('USER', 'ROLE', 'ORGANIZATION_CHAT');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cart_id","product_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "placed_by_user_id" UUID NOT NULL,
    "price_list_version_id" UUID NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'SUBMITTED',
    "payment_status" "payment_status" NOT NULL DEFAULT 'UNPAID',
    "accounting_mode" "accounting_mode" NOT NULL DEFAULT 'PENDING',
    "accounting_cleared_at" TIMESTAMPTZ(3),
    "accounting_reviewed_at" TIMESTAMPTZ(3),
    "accounting_reviewed_by" UUID,
    "driver_user_id" UUID,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "customer_comment" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "row_version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_code_snapshot" TEXT NOT NULL,
    "name_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "line_total" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "event_type" "order_event_type" NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status",
    "actor_user_id" UUID,
    "actor_role" TEXT NOT NULL,
    "comment" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "recipient_kind" "notification_recipient_kind" NOT NULL,
    "recipient_user_id" UUID,
    "recipient_role" TEXT,
    "recipient_organization_id" UUID,
    "order_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "carts_user_id_organization_id_key" ON "carts"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_organization_id_submitted_at_idx" ON "orders"("organization_id", "submitted_at");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_driver_user_id_idx" ON "orders"("driver_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_organization_id_idempotency_key_key" ON "orders"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_product_id_key" ON "order_items"("order_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_events_seq_key" ON "order_events"("seq");

-- CreateIndex
CREATE INDEX "order_events_order_id_seq_idx" ON "order_events"("order_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupe_key_key" ON "notification_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_outbox_status_created_at_idx" ON "notification_outbox"("status", "created_at");

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_placed_by_user_id_fkey" FOREIGN KEY ("placed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_user_id_fkey" FOREIGN KEY ("driver_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_accounting_reviewed_by_fkey" FOREIGN KEY ("accounting_reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_list_version_id_fkey" FOREIGN KEY ("price_list_version_id") REFERENCES "price_list_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_organization_id_fkey" FOREIGN KEY ("recipient_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Hand-written part: what Prisma cannot express.
-- =======================================================================================

-- Human-readable order numbers: "IO-" || n, n from this sequence. The prefix lives in the
-- application (ORDER_NUMBER_PREFIX), the first number here (ORDER_NUMBER_START). The real
-- format is an open product question (data-model section 5, question 5). Gaps are possible
-- (a rolled-back submit consumes a number) and meaningless.
CREATE SEQUENCE "order_number_seq" START WITH 10001 MINVALUE 10001;

-- ---------------------------------------------------------------------------------------
-- carts
-- ---------------------------------------------------------------------------------------
ALTER TABLE "cart_items"
    ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0);

-- ---------------------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------------------
-- Hard rule 1: money is a fixed-point decimal; customers see UZS only.
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_currency_uzs" CHECK ("currency" = 'UZS'),
    ADD CONSTRAINT "orders_total_non_negative" CHECK ("total_amount" >= 0),
    ADD CONSTRAINT "orders_row_version_positive" CHECK ("row_version" >= 1),
    ADD CONSTRAINT "orders_idempotency_key_not_blank" CHECK (btrim("idempotency_key") <> ''),
    ADD CONSTRAINT "orders_order_number_not_blank" CHECK (btrim("order_number") <> ''),
    -- accounting_cleared_at is set exactly when the accounting step was passed (approved or
    -- skipped); "PENDING" means it was not.
    ADD CONSTRAINT "orders_accounting_mode_matches_clearance"
        CHECK (("accounting_mode" = 'PENDING') = ("accounting_cleared_at" IS NULL)),
    -- Statuses that are only reachable through the accounting step carry the clearance.
    ADD CONSTRAINT "orders_cleared_statuses_have_clearance"
        CHECK ("status" NOT IN ('ACCOUNTING_CLEARED', 'RELEASED', 'DELIVERED', 'RECEIVED')
               OR "accounting_cleared_at" IS NOT NULL),
    -- Before the accountant (or the skip) the order is never cleared.
    ADD CONSTRAINT "orders_early_statuses_not_cleared"
        CHECK ("status" NOT IN ('SUBMITTED', 'MANAGER_APPROVED') OR "accounting_cleared_at" IS NULL),
    -- Release names the driver, so every later status has one.
    ADD CONSTRAINT "orders_released_statuses_have_driver"
        CHECK ("status" NOT IN ('RELEASED', 'DELIVERED', 'RECEIVED') OR "driver_user_id" IS NOT NULL),
    ADD CONSTRAINT "orders_accounting_review_pair"
        CHECK (("accounting_reviewed_at" IS NULL) = ("accounting_reviewed_by" IS NULL));

-- An order is never deleted (history), and the table is never emptied by accident.
CREATE FUNCTION orders_never_deleted() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'orders cannot be deleted (% rejected)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_no_delete"
    BEFORE DELETE ON "orders"
    FOR EACH ROW EXECUTE FUNCTION orders_never_deleted();

CREATE TRIGGER "orders_no_truncate"
    BEFORE TRUNCATE ON "orders"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- Identity facts of an order never change after it was placed (only its progress does).
CREATE FUNCTION orders_identity_frozen() RETURNS trigger AS $$
BEGIN
    IF NEW."order_number" IS DISTINCT FROM OLD."order_number"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."placed_by_user_id" IS DISTINCT FROM OLD."placed_by_user_id"
       OR NEW."price_list_version_id" IS DISTINCT FROM OLD."price_list_version_id"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
       OR NEW."currency" IS DISTINCT FROM OLD."currency" THEN
        RAISE EXCEPTION 'order identity columns are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- The total only changes together with the content (row_version moves), never silently.
    IF NEW."total_amount" IS DISTINCT FROM OLD."total_amount"
       AND NEW."row_version" = OLD."row_version" THEN
        RAISE EXCEPTION 'the order total can only change together with row_version'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."row_version" < OLD."row_version" THEN
        RAISE EXCEPTION 'row_version cannot go back' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_identity_frozen_guard"
    BEFORE UPDATE ON "orders"
    FOR EACH ROW EXECUTE FUNCTION orders_identity_frozen();

-- ---------------------------------------------------------------------------------------
-- order_items: the price snapshot
-- ---------------------------------------------------------------------------------------
ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
    ADD CONSTRAINT "order_items_unit_price_non_negative" CHECK ("unit_price" >= 0),
    -- line_total is exactly quantity x unit price rounded to the currency's two decimals.
    ADD CONSTRAINT "order_items_line_total_exact"
        CHECK ("line_total" = round("quantity" * "unit_price", 2)),
    ADD CONSTRAINT "order_items_snapshots_not_blank"
        CHECK (btrim("product_code_snapshot") <> '' AND btrim("name_snapshot") <> ''
               AND btrim("unit_snapshot") <> '');

-- Items may change only while the order is SUBMITTED (the manager's edit, lifecycle 3.2).
-- Hard rule 4 and invariant 5 at the database level. The edit transaction first updates the
-- order row (conditional on status and row_version), so this read sees the committed status
-- and a concurrent approval cannot slip in between.
CREATE FUNCTION order_items_only_while_submitted() RETURNS trigger AS $$
DECLARE
    parent_id uuid;
    parent_status order_status;
BEGIN
    IF TG_OP = 'DELETE' THEN parent_id := OLD."order_id"; ELSE parent_id := NEW."order_id"; END IF;
    SELECT "status" INTO parent_status FROM "orders" WHERE "id" = parent_id;
    IF parent_status IS NULL THEN
        RAISE EXCEPTION 'order % does not exist', parent_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF parent_status <> 'SUBMITTED' THEN
        RAISE EXCEPTION 'order items are immutable once the order left SUBMITTED (% rejected)', TG_OP
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW."order_id" IS DISTINCT FROM OLD."order_id"
                             OR NEW."product_id" IS DISTINCT FROM OLD."product_id") THEN
        RAISE EXCEPTION 'an order line cannot move to another order or product'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "order_items_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "order_items"
    FOR EACH ROW EXECUTE FUNCTION order_items_only_while_submitted();

CREATE TRIGGER "order_items_no_truncate"
    BEFORE TRUNCATE ON "order_items"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- Invariant 5: orders.total_amount = sum(order_items.line_total) after every create/edit.
-- Checked at COMMIT (deferred), because the order row and its lines are written one by one.
CREATE FUNCTION order_total_matches_lines() RETURNS trigger AS $$
DECLARE
    target uuid;
    lines_total numeric;
    stored_total numeric;
    line_count bigint;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN target := NEW."id";
    ELSIF TG_OP = 'DELETE' THEN target := OLD."order_id";
    ELSE target := NEW."order_id";
    END IF;
    SELECT "total_amount" INTO stored_total FROM "orders" WHERE "id" = target;
    IF stored_total IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(sum("line_total"), 0), count(*) INTO lines_total, line_count
        FROM "order_items" WHERE "order_id" = target;
    IF line_count = 0 THEN
        RAISE EXCEPTION 'order % has no lines', target USING ERRCODE = 'check_violation';
    END IF;
    IF lines_total <> stored_total THEN
        RAISE EXCEPTION 'order % total % does not equal the sum of its lines %',
            target, stored_total, lines_total USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "orders_total_matches_lines"
    AFTER INSERT OR UPDATE OF "total_amount" ON "orders"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_total_matches_lines();

CREATE CONSTRAINT TRIGGER "order_items_total_matches_lines"
    AFTER INSERT OR UPDATE OR DELETE ON "order_items"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION order_total_matches_lines();

-- ---------------------------------------------------------------------------------------
-- order_events: append-only (hard rule 3), same pattern as audit_log
-- ---------------------------------------------------------------------------------------
ALTER TABLE "order_events"
    ADD CONSTRAINT "order_events_actor_role_not_blank" CHECK (btrim("actor_role") <> ''),
    ADD CONSTRAINT "order_events_comment_not_blank"
        CHECK ("comment" IS NULL OR btrim("comment") <> ''),
    -- A reject or cancel always carries its reason, also when a customer cancels.
    ADD CONSTRAINT "order_events_reason_required"
        CHECK ("to_status" IS NULL OR "to_status" NOT IN ('REJECTED', 'CANCELLED')
               OR "comment" IS NOT NULL),
    ADD CONSTRAINT "order_events_status_events_have_statuses"
        CHECK ("event_type" NOT IN ('STATUS_CHANGED', 'ACCOUNTING_SKIPPED')
               OR ("from_status" IS NOT NULL AND "to_status" IS NOT NULL)),
    ADD CONSTRAINT "order_events_submitted_shape"
        CHECK ("event_type" <> 'SUBMITTED'
               OR ("from_status" IS NULL AND "to_status" = 'SUBMITTED')),
    ADD CONSTRAINT "order_events_payload_has_before_after"
        CHECK (jsonb_typeof("payload") = 'object' AND "payload" ? 'before' AND "payload" ? 'after');

CREATE FUNCTION order_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'order_events is append-only (% rejected)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "order_events_no_update_delete"
    BEFORE UPDATE OR DELETE ON "order_events"
    FOR EACH ROW EXECUTE FUNCTION order_events_append_only();

CREATE TRIGGER "order_events_no_truncate"
    BEFORE TRUNCATE ON "order_events"
    FOR EACH STATEMENT EXECUTE FUNCTION order_events_append_only();

-- ---------------------------------------------------------------------------------------
-- notification_outbox: rows are kept after sending; only delivery bookkeeping may change
-- ---------------------------------------------------------------------------------------
ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_attempts_non_negative" CHECK ("attempts" >= 0),
    ADD CONSTRAINT "notification_outbox_dedupe_key_not_blank" CHECK (btrim("dedupe_key") <> ''),
    ADD CONSTRAINT "notification_outbox_payload_is_object" CHECK (jsonb_typeof("payload") = 'object'),
    -- Exactly the recipient column that belongs to the kind is set.
    ADD CONSTRAINT "notification_outbox_recipient_matches_kind" CHECK (
        ("recipient_kind" = 'USER'
            AND "recipient_user_id" IS NOT NULL AND "recipient_role" IS NULL
            AND "recipient_organization_id" IS NULL)
        OR ("recipient_kind" = 'ROLE'
            AND "recipient_role" IS NOT NULL AND "recipient_user_id" IS NULL
            AND "recipient_organization_id" IS NULL)
        OR ("recipient_kind" = 'ORGANIZATION_CHAT'
            AND "recipient_organization_id" IS NOT NULL AND "recipient_user_id" IS NULL
            AND "recipient_role" IS NULL)),
    ADD CONSTRAINT "notification_outbox_sent_at_matches_status"
        CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL));

CREATE FUNCTION notification_outbox_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification_outbox rows are kept (DELETE rejected)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."recipient_kind" IS DISTINCT FROM OLD."recipient_kind"
       OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
       OR NEW."recipient_role" IS DISTINCT FROM OLD."recipient_role"
       OR NEW."recipient_organization_id" IS DISTINCT FROM OLD."recipient_organization_id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'only status, attempts and sent_at of a notification may change'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'SENT' THEN
        RAISE EXCEPTION 'a sent notification is final' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "notification_outbox_guard_rows"
    BEFORE UPDATE OR DELETE ON "notification_outbox"
    FOR EACH ROW EXECUTE FUNCTION notification_outbox_guard();

CREATE TRIGGER "notification_outbox_no_truncate"
    BEFORE TRUNCATE ON "notification_outbox"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
