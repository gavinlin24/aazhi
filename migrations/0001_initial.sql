-- Amounts are integer cents; timestamps are ISO-8601 text.

CREATE TABLE bills (
  id                  TEXT PRIMARY KEY,
  guild_id            TEXT NOT NULL,
  channel_id          TEXT NOT NULL,
  message_id          TEXT,
  payer_id            TEXT NOT NULL,
  place               TEXT,
  bill_date           TEXT,
  tax_cents           INTEGER NOT NULL DEFAULT 0,
  tip_cents           INTEGER NOT NULL DEFAULT 0,
  printed_total_cents INTEGER,
  -- A reopened bill goes back to 'draft'; confirmed_at surviving is what marks
  -- it as once confirmed.
  status              TEXT NOT NULL CHECK (status IN ('reading', 'draft', 'confirmed', 'superseded', 'deleted')),
  revision            INTEGER NOT NULL DEFAULT 1,
  -- Epoch ms until which a Discord message edit is already scheduled for this
  -- bill. D1-backed because Worker isolates share no memory.
  edit_lease_until    INTEGER,
  created_at          TEXT NOT NULL,
  confirmed_at        TEXT
);

-- The open-draft lookup for a channel.
CREATE INDEX idx_bills_channel_status ON bills (channel_id, status);

CREATE TABLE bill_items (
  id         TEXT PRIMARY KEY,
  bill_id    TEXT NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  cents      INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('ocr', 'manual')),
  -- How sure the extraction was of this line. Never money.
  confidence REAL
);

-- Also serves the page render: one ordered read of a bill's items.
CREATE INDEX idx_bill_items_bill ON bill_items (bill_id, position);

CREATE TABLE participants (
  bill_id      TEXT NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
  display_name TEXT NOT NULL,
  -- The member a guest's share is billed to. A guest is a label on one bill:
  -- its id is generated per bill and no person row exists for it.
  added_by     TEXT,
  PRIMARY KEY (bill_id, id),
  CHECK ((kind = 'member' AND added_by IS NULL) OR (kind = 'guest' AND added_by IS NOT NULL))
);

-- The (bill_item_id, participant_id) key doubles as the index on bill_item_id,
-- so a claim is a per-row upsert and "who claimed this item" needs no second index.
CREATE TABLE item_claims (
  bill_item_id   TEXT NOT NULL REFERENCES bill_items (id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  PRIMARY KEY (bill_item_id, participant_id)
);

-- Written at confirm so a confirmed bill's numbers are frozen, not recomputed.
-- Kept across a reopen so a re-confirm re-applies the pardon flags.
CREATE TABLE shares (
  bill_id        TEXT NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  tax_cents      INTEGER NOT NULL,
  tip_cents      INTEGER NOT NULL,
  owed_cents     INTEGER NOT NULL,
  pardoned       INTEGER NOT NULL DEFAULT 0 CHECK (pardoned IN (0, 1)),
  -- A timestamp rather than a flag, so time-to-settle stays computable.
  settled_at     TEXT,
  PRIMARY KEY (bill_id, participant_id),
  FOREIGN KEY (bill_id, participant_id) REFERENCES participants (bill_id, id)
);

-- An amount, not a flag, so a partial payment is an ordinary row.
CREATE TABLE settlements (
  id             TEXT PRIMARY KEY,
  bill_id        TEXT NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  cents          INTEGER NOT NULL,
  recorded_at    TEXT NOT NULL,
  recorded_by    TEXT NOT NULL,
  FOREIGN KEY (bill_id, participant_id) REFERENCES participants (bill_id, id)
);

CREATE INDEX idx_settlements_bill ON settlements (bill_id);
