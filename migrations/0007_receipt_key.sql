-- Which printed receipt a bill came from. Bills read before this have no key,
-- and can't be given one: the printed time was never stored.
ALTER TABLE bills ADD COLUMN receipt_key TEXT;

-- A receipt is credited by at most one confirmed bill, anywhere. It lives here
-- so that two Confirms at the same moment can't both land.
CREATE UNIQUE INDEX idx_bills_confirmed_receipt_key ON bills (receipt_key)
  WHERE status = 'confirmed' AND receipt_key IS NOT NULL;
