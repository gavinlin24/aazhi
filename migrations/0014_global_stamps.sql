-- A person now holds a stamp once, across every server. One row per person and
-- stamp, so a stamp earned in one server is seen everywhere.
--
-- The old Worker keeps serving until the new one lands, and it reads and writes
-- guild_id, so the column stays, nullable, with nothing new reading or writing it.
-- It can go in a later migration once the new Worker is live. Until then the old
-- Worker sees only the rows that kept its server, and its inserts land or hit the
-- new key and do nothing, so a page never fails in the gap.
--
-- A failed migration rolls back, and DROP TABLE comes after the rows are in the
-- new table, so nothing is lost either way. Nothing references stamps, so unlike
-- bills it can be rebuilt.
CREATE TABLE stamps_held (
  user_id   TEXT NOT NULL,
  key       TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  bill_id   TEXT,
  seen_at   TEXT,
  guild_id  TEXT,
  PRIMARY KEY (user_id, key)
);

-- The earliest row wins, with the bill that earned it. seen_at is the first one
-- set, so a Ceremony played in any server never plays again. MIN skips nulls, so
-- it stays null only if no server has shown it. A log whose post named a later
-- copy of a stamp loses that line on its next rename.
INSERT INTO stamps_held (user_id, key, earned_at, bill_id, seen_at, guild_id)
SELECT user_id, key, earned_at, bill_id, first_seen, guild_id FROM (
  SELECT *, MIN(seen_at) OVER (PARTITION BY user_id, key) AS first_seen,
    ROW_NUMBER() OVER (PARTITION BY user_id, key ORDER BY earned_at, guild_id) AS nth
  FROM stamps
) WHERE nth = 1;

-- Everything below gives what people reach only once servers add up, dated when
-- they crossed the line and marked seen, so nobody opens a page to a pile of
-- Ceremonies. It mirrors src/db/stamps.ts and folds names by ASCII only, the same
-- as 0012, and test/db/stamps.test.ts holds the two together. First Seat, Full
-- Table, Clean Books and Magnanimous each come from one bill, so adding servers
-- can't reach them and 0012 already gave them. OR IGNORE leaves a merged row as it
-- is. D1 refuses a compound SELECT past five terms, hence one INSERT per rule.
CREATE VIEW stamp_backfill_outing AS
  SELECT b.id AS bill_id, b.kind, b.payer_id, p.id AS person,
    COALESCE(b.confirmed_at, b.created_at) AS at,
    lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      COALESCE(b.place, ''), ' ', ''), '.', ''), ',', ''), '''', ''), '’', ''), '!', ''), '-', ''), '&', ''), '#', ''), '(', ''), ')', '')) AS place_key
  FROM participants p JOIN bills b ON b.id = p.bill_id
  WHERE p.kind = 'member' AND b.status = 'confirmed'
    AND EXISTS (SELECT 1 FROM shares x WHERE x.bill_id = b.id AND x.participant_id = p.id AND x.owed_cents > 0)
    AND (b.kind = 'log' OR EXISTS (SELECT 1 FROM shares x WHERE x.bill_id = b.id AND x.participant_id <> p.id AND x.owed_cents > 0));

CREATE VIEW stamp_backfill_claim AS
  SELECT o.person, o.kind, o.at, i.id AS item_id,
    lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      i.label, ' ', ''), '.', ''), ',', ''), '''', ''), '’', ''), '!', ''), '-', ''), '&', ''), '#', ''), '(', ''), ')', '')) AS item_key,
    EXISTS (SELECT 1 FROM item_claims x WHERE x.bill_item_id = i.id AND x.participant_id <> o.person) AS shared
  FROM stamp_backfill_outing o
  JOIN bill_items i ON i.bill_id = o.bill_id AND i.cents > 0
  JOIN item_claims c ON c.bill_item_id = i.id AND c.participant_id = o.person;

-- Host: the fifth bill hosted.
INSERT OR IGNORE INTO stamps_held (user_id, key, earned_at, seen_at)
SELECT person, 'host', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT person, at, ROW_NUMBER() OVER (PARTITION BY person ORDER BY at, bill_id) AS nth
  FROM stamp_backfill_outing WHERE kind = 'split' AND payer_id = person
) WHERE nth = 5;

-- Regular: the earliest third visit to any one place.
INSERT OR IGNORE INTO stamps_held (user_id, key, earned_at, seen_at)
SELECT person, 'regular', MIN(at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT person, at, ROW_NUMBER() OVER (PARTITION BY person, place_key ORDER BY at, bill_id) AS nth
  FROM stamp_backfill_outing WHERE place_key <> ''
) WHERE nth = 3 GROUP BY person;

-- Traveler: the first visit to a tenth place.
INSERT OR IGNORE INTO stamps_held (user_id, key, earned_at, seen_at)
SELECT person, 'traveler', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT person, at, ROW_NUMBER() OVER (PARTITION BY person ORDER BY at, place_key) AS nth
  FROM (SELECT person, place_key, MIN(at) AS at FROM stamp_backfill_outing WHERE place_key <> '' GROUP BY person, place_key)
) WHERE nth = 10;

-- Hundred Flavors: the first try of a twenty-fifth item.
INSERT OR IGNORE INTO stamps_held (user_id, key, earned_at, seen_at)
SELECT person, 'hundred-flavors', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT person, at, ROW_NUMBER() OVER (PARTITION BY person ORDER BY at, item_key) AS nth
  FROM (SELECT person, item_key, MIN(at) AS at FROM stamp_backfill_claim WHERE item_key <> '' GROUP BY person, item_key)
) WHERE nth = 25;

-- Sharing the Sweet: the tenth shared item.
INSERT OR IGNORE INTO stamps_held (user_id, key, earned_at, seen_at)
SELECT person, 'sharing', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT person, at, ROW_NUMBER() OVER (PARTITION BY person ORDER BY at, item_id) AS nth
  FROM stamp_backfill_claim WHERE kind = 'split' AND shared = 1
) WHERE nth = 10;

-- Word Kept: the tenth bill someone recorded their own payment on.
INSERT OR IGNORE INTO stamps_held (user_id, key, earned_at, seen_at)
SELECT person, 'word-kept', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT s.participant_id AS person, MIN(s.recorded_at) AS at,
    ROW_NUMBER() OVER (PARTITION BY s.participant_id ORDER BY MIN(s.recorded_at), s.bill_id) AS nth
  FROM settlements s JOIN bills b ON b.id = s.bill_id
  WHERE b.status = 'confirmed' AND b.kind = 'split' AND s.recorded_by = s.participant_id
  GROUP BY s.participant_id, s.bill_id
) WHERE nth = 10;

DROP VIEW stamp_backfill_claim;
DROP VIEW stamp_backfill_outing;

DROP TABLE stamps;
ALTER TABLE stamps_held RENAME TO stamps;

-- Every bill page asks this on each poll.
CREATE INDEX idx_stamps_unseen ON stamps (user_id) WHERE seen_at IS NULL;
