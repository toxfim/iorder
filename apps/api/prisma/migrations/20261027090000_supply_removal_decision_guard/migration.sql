-- A decided removal request is final. The only allowed change of a row is the decision itself:
-- PENDING -> CONFIRMED or PENDING -> DISMISSED, with the identity of the request untouched.
-- Requests are never deleted (the application role has no DELETE grant; this is the second line).

CREATE FUNCTION supply_removal_requests_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'supply removal requests cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" <> 'PENDING' THEN
        RAISE EXCEPTION 'supply removal request % is already decided and cannot change', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."status" = 'PENDING'
        OR NEW."id" <> OLD."id"
        OR NEW."product_id" <> OLD."product_id"
        OR NEW."delivery_ref" <> OLD."delivery_ref"
        OR NEW."detected_at" <> OLD."detected_at" THEN
        RAISE EXCEPTION 'supply removal request % may only be decided (PENDING to CONFIRMED or DISMISSED)', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "supply_removal_requests_guard"
    BEFORE UPDATE OR DELETE ON "supply_removal_requests"
    FOR EACH ROW EXECUTE FUNCTION supply_removal_requests_guard();
