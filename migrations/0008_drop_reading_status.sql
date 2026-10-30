-- No bill was ever written as 'reading'. The usual rebuild is not an option
-- here: DROP TABLE bills runs an implicit DELETE, the ON DELETE CASCADE keys
-- then empty every child table, D1 can't turn foreign keys off, and
-- defer_foreign_keys doesn't stop a cascade. Swapping the column in place
-- never deletes a bill. ADD COLUMN needs a default to be NOT NULL, so 'draft'
-- stays as one, and createBill always sets the status anyway. A bill in any
-- other status fails the CHECK and rolls the migration back.
DROP INDEX idx_bills_channel_status;
DROP INDEX idx_bills_guild_status;
DROP INDEX idx_bills_confirmed_receipt_key;

ALTER TABLE bills ADD COLUMN status_new TEXT NOT NULL DEFAULT 'draft'
  CHECK (status_new IN ('draft', 'confirmed', 'superseded', 'deleted'));
UPDATE bills SET status_new = status;
ALTER TABLE bills DROP COLUMN status;
ALTER TABLE bills RENAME COLUMN status_new TO status;

CREATE INDEX idx_bills_channel_status ON bills (channel_id, status);
CREATE INDEX idx_bills_guild_status ON bills (guild_id, status);
CREATE UNIQUE INDEX idx_bills_confirmed_receipt_key ON bills (receipt_key)
  WHERE status = 'confirmed' AND receipt_key IS NOT NULL;
