-- Which printed receipt a bill came from, so one receipt can't sit on bills in
-- two servers. Bills read before this have no key, and can't be given one: the
-- printed time was never stored.
ALTER TABLE bills ADD COLUMN receipt_key TEXT;

CREATE INDEX idx_bills_receipt_key ON bills (receipt_key) WHERE receipt_key IS NOT NULL;
