-- [C] 2026-10-30: the purchasing manager reads what the sales manager reads and acts on nothing.
-- Not used in this transaction (PostgreSQL forbids using a value added in the same one). The goods
-- that count as marked are data (products.marking_required), set by the manager, not seeded here.
ALTER TYPE "staff_role" ADD VALUE 'PURCHASING_MANAGER';
