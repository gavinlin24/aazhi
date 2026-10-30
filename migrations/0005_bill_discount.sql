-- Money off the whole bill, like a promo or a comp printed under the
-- subtotal. A bill-level amount like tax rather than a line, because nobody
-- claims it: everyone's share of it follows what they ordered. Stored
-- positive. A discount on one dish is that dish's price instead.
ALTER TABLE bills ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);

-- Each person's slice of it, frozen at confirm with the rest of their share.
ALTER TABLE shares ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
