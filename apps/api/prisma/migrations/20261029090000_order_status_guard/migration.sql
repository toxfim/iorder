-- Hard rule 2 at the database level: orders.status moves only along the transition table, and
-- only together with an order_events row. The application already does this in one function;
-- these triggers make a bug, a script or a hand-written UPDATE fail instead of corrupting history.

-- ---------------------------------------------------------------------------------------
-- THE transition table, in ONE place in SQL.
-- It mirrors TRANSITION_RULES in apps/api/src/modules/orders/order-state-machine.ts (docs:
-- order-lifecycle.md section 3). A unit/integration test compares this function with the
-- TypeScript table for all 8 x 8 status pairs, so the two cannot drift. Skip-accounting is two
-- moves (SUBMITTED -> MANAGER_APPROVED -> ACCOUNTING_CLEARED), never a jump.
-- Terminal statuses (RECEIVED, REJECTED, CANCELLED) appear on the left of no pair.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION order_status_move_allowed(old_status order_status, new_status order_status)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM (VALUES
            ('SUBMITTED'::order_status,          'MANAGER_APPROVED'::order_status),
            ('SUBMITTED'::order_status,          'REJECTED'::order_status),
            ('SUBMITTED'::order_status,          'CANCELLED'::order_status),
            ('MANAGER_APPROVED'::order_status,   'ACCOUNTING_CLEARED'::order_status),
            ('MANAGER_APPROVED'::order_status,   'REJECTED'::order_status),
            ('MANAGER_APPROVED'::order_status,   'CANCELLED'::order_status),
            ('ACCOUNTING_CLEARED'::order_status, 'RELEASED'::order_status),
            ('ACCOUNTING_CLEARED'::order_status, 'CANCELLED'::order_status),
            ('RELEASED'::order_status,           'DELIVERED'::order_status),
            ('DELIVERED'::order_status,          'RECEIVED'::order_status)
        ) AS moves (from_status, to_status)
        WHERE moves.from_status = old_status AND moves.to_status = new_status
    );
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION orders_status_move_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'SUBMITTED' THEN
            RAISE EXCEPTION 'an order starts in SUBMITTED, not %', NEW."status"
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
        IF OLD."status" IN ('RECEIVED', 'REJECTED', 'CANCELLED') THEN
            RAISE EXCEPTION 'order status % is final and cannot change (to %)',
                OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT order_status_move_allowed(OLD."status", NEW."status") THEN
            RAISE EXCEPTION 'order status cannot move from % to %', OLD."status", NEW."status"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "orders_status_move_guard_rows"
    BEFORE INSERT OR UPDATE OF "status" ON "orders"
    FOR EACH ROW EXECUTE FUNCTION orders_status_move_guard();

-- ---------------------------------------------------------------------------------------
-- A status change must come with its order_events row, checked at COMMIT (the order row and the
-- event are written one after the other inside one transaction). The check looks for an event of
-- exactly this move (order, from, to). A move happens at most once per order, so "an event of
-- this move exists" is, in practice, "this transaction wrote it"; a stricter same-transaction
-- check (xmin) would break under savepoints, so it is not used.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION orders_status_change_has_event() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "order_events"
        WHERE "order_id" = NEW."id"
          AND "from_status" = OLD."status"
          AND "to_status" = NEW."status"
    ) THEN
        RAISE EXCEPTION 'order % moved % -> % without an order_events row',
            NEW."id", OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "orders_status_change_has_event_commit"
    AFTER UPDATE OF "status" ON "orders"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD."status" IS DISTINCT FROM NEW."status")
    EXECUTE FUNCTION orders_status_change_has_event();
