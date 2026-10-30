-- A log is a one-person bill: same rows, same page, same frozen share, and it
-- owes nobody. It gets its own kind rather than its own tables so stats, the
-- profile and the page keep reading one shape.
ALTER TABLE bills ADD COLUMN kind TEXT NOT NULL DEFAULT 'split' CHECK (kind IN ('split', 'log'));
-- 24-hour HH:MM as printed. The page shows it, and /log's 8 hours run from it.
ALTER TABLE bills ADD COLUMN bill_time TEXT;
-- The photos a flagged log came from. Set is what flagged means, and it is
-- cleared once they are posted, because Discord's links don't outlive a day.
ALTER TABLE bills ADD COLUMN photo_urls TEXT;
-- Null until a flagged log is logged. 'open' while the server votes, on a bill
-- still in draft so that nothing counts it, then 'real' or 'fake'.
ALTER TABLE bills ADD COLUMN vote TEXT CHECK (vote IN ('open', 'real', 'fake'));

CREATE TABLE log_votes (
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  real INTEGER NOT NULL CHECK (real IN (0, 1)),
  voted_at TEXT NOT NULL,
  PRIMARY KEY (bill_id, voter_id)
);

-- One receipt credits once per kind. A log and a split of the same receipt are
-- not stopped by the index: a split confirmed later takes over from the logs of
-- the people on it, which is code's job, and a log has already been refused if
-- the split came first.
DROP INDEX idx_bills_confirmed_receipt_key;
CREATE UNIQUE INDEX idx_bills_confirmed_receipt_key ON bills (receipt_key)
  WHERE kind = 'split' AND status = 'confirmed' AND receipt_key IS NOT NULL;
-- An open vote holds the receipt too, or a second person could log it while the
-- server decides on the first.
CREATE UNIQUE INDEX idx_bills_logged_receipt_key ON bills (receipt_key)
  WHERE kind = 'log' AND receipt_key IS NOT NULL AND (status = 'confirmed' OR vote = 'open');
-- The two above are partial, so looking a receipt up across every state needs its own.
CREATE INDEX idx_bills_receipt_key ON bills (receipt_key) WHERE receipt_key IS NOT NULL;
-- Your logs, and clearing someone's stale drafts on a new /log.
CREATE INDEX idx_bills_payer_kind ON bills (payer_id, kind, status);
