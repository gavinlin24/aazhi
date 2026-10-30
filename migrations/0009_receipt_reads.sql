-- One row per Claude call on a receipt, so the read limit can count what was
-- spent. `day` is the America/Los_Angeles date the call landed on, stored
-- rather than derived because SQLite can't convert time zones. No indexes: the
-- global cap and the two-day retention keep this table to a few hundred rows.
CREATE TABLE receipt_reads (
  user_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  photos INTEGER NOT NULL
);
