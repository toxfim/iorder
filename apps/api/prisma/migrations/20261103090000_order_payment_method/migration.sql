-- Payment method chosen by the manager on approval ([C] 2026-10-24): "Naqd" (CASH) or "Official".
CREATE TYPE "payment_method" AS ENUM ('CASH', 'OFFICIAL');

ALTER TABLE "orders" ADD COLUMN "payment_method" "payment_method";

ALTER TYPE "order_event_type" ADD VALUE 'PAYMENT_METHOD_CHANGED' AFTER 'PAYMENT_STATUS_CHANGED';
