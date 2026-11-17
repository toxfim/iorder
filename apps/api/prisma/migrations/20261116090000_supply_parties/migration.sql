-- Party numbers ([C] owner 2026-10-30): the manager attaches one to a whole supply (delivery_ref).
-- Additive: one new table. A party is trimmed text of 1 to 32 characters, compared exactly.

CREATE TABLE "supply_parties" (
    "delivery_ref" TEXT NOT NULL,
    "party_number" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supply_parties_pkey" PRIMARY KEY ("delivery_ref"),
    CONSTRAINT "supply_parties_party_number_format" CHECK (
        "party_number" = btrim("party_number") AND char_length("party_number") BETWEEN 1 AND 32
    )
);

CREATE INDEX "supply_parties_party_number_idx" ON "supply_parties"("party_number");
