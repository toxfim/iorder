-- Organization payments ([C] 2026-10-26): the debt is kept per organization, not per order. It is
-- the total of the RECEIVED orders minus the payments that are not voided. Only the manager records
-- a payment (amount, day, optional comment); only the admin corrects or voids one (audit_log keeps
-- before/after). orders.payment_status is derived from it, oldest received order first.

-- ---------------------------------------------------------------- orders.received_at

ALTER TABLE "orders" ADD COLUMN "received_at" TIMESTAMPTZ(3);

-- Existing received orders: the time of the event that moved them to RECEIVED.
UPDATE "orders" AS o
SET "received_at" = e.created_at
FROM (
    SELECT order_id, max(created_at) AS created_at
    FROM "order_events"
    WHERE to_status = 'RECEIVED'
    GROUP BY order_id
) AS e
WHERE e.order_id = o.id AND o.status = 'RECEIVED';
UPDATE "orders" SET "received_at" = "updated_at" WHERE "status" = 'RECEIVED' AND "received_at" IS NULL;

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_received_at_when_received"
        CHECK ("status" <> 'RECEIVED' OR "received_at" IS NOT NULL);

CREATE INDEX "orders_organization_id_received_at_idx"
    ON "orders"("organization_id", "received_at") WHERE "status" = 'RECEIVED';

-- ---------------------------------------------------------------- organization_payments

CREATE TABLE "organization_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "comment" TEXT,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_payments_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "organization_payments_comment_not_blank"
        CHECK ("comment" IS NULL OR (btrim("comment") <> '' AND length("comment") <= 500)),
    CONSTRAINT "organization_payments_void_complete"
        CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL)
           AND ("voided_at" IS NULL) = ("void_reason" IS NULL)),
    CONSTRAINT "organization_payments_void_reason_not_blank"
        CHECK ("void_reason" IS NULL OR btrim("void_reason") <> '')
);

CREATE INDEX "organization_payments_organization_id_recorded_at_idx"
    ON "organization_payments"("organization_id", "recorded_at");

ALTER TABLE "organization_payments"
    ADD CONSTRAINT "organization_payments_organization_id_fkey" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "organization_payments_recorded_by_fkey" FOREIGN KEY ("recorded_by")
        REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "organization_payments_voided_by_fkey" FOREIGN KEY ("voided_by")
        REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Never deleted. Who recorded it, for which organization and when never change; a void is final
-- and a voided payment is not corrected any more.
CREATE FUNCTION organization_payments_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'organization_payments are voided, never deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.organization_id <> OLD.organization_id
       OR NEW.recorded_by <> OLD.recorded_by
       OR NEW.recorded_at <> OLD.recorded_at THEN
        RAISE EXCEPTION 'the origin of a payment never changes' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'a voided payment never changes' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organization_payments_guard_rows"
    BEFORE UPDATE OR DELETE ON "organization_payments"
    FOR EACH ROW EXECUTE FUNCTION organization_payments_guard();
CREATE TRIGGER "organization_payments_no_truncate"
    BEFORE TRUNCATE ON "organization_payments"
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
