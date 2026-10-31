-- One row for each stamp a person holds in a server. A stamp is never taken
-- back, so nothing deletes from here. seen_at stays null until the Ceremony has
-- played. bill_id is the bill that earned it, for the line on that bill's post.
CREATE TABLE stamps (
  guild_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  key       TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  bill_id   TEXT,
  seen_at   TEXT,
  PRIMARY KEY (guild_id, user_id, key)
);

-- Every bill page asks this on each poll.
CREATE INDEX idx_stamps_unseen ON stamps (user_id, guild_id) WHERE seen_at IS NULL;

-- Everything below is the backfill: stamps people already qualify for, dated when
-- they crossed the line and marked seen, so nobody opens a page to ten Ceremonies
-- in a row. It has to be SQL because a deploy runs it before the new Worker
-- exists. It mirrors the rules in src/db/stamps.ts as they stood at launch, and
-- test/db/stamps.test.ts holds the two together.
--
-- Folding here is ASCII only, since SQLite can't do better, so two spellings that
-- differ by an accent count as two places. bill_id stays null because these bills'
-- posts went out long ago. A bill confirmed after this runs and before the new
-- Worker lands is earned at that person's next bill, with a Ceremony.
--
-- D1 refuses a compound SELECT past five terms, hence one INSERT per rule and
-- these two views, which are gone again by the end of the file.
CREATE VIEW stamp_backfill_outing AS
  -- The same row src/db/stats.ts counts: a member with a share on a confirmed
  -- bill, on a log or with somebody else on the bill.
  SELECT b.id AS bill_id, b.guild_id, b.kind, b.payer_id, p.id AS person,
    COALESCE(b.confirmed_at, b.created_at) AS at,
    lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      COALESCE(b.place, ''), ' ', ''), '.', ''), ',', ''), '''', ''), '’', ''), '!', ''), '-', ''), '&', ''), '#', ''), '(', ''), ')', '')) AS place_key
  FROM participants p JOIN bills b ON b.id = p.bill_id
  WHERE p.kind = 'member' AND b.status = 'confirmed'
    AND EXISTS (SELECT 1 FROM shares x WHERE x.bill_id = b.id AND x.participant_id = p.id AND x.owed_cents > 0)
    AND (b.kind = 'log' OR EXISTS (SELECT 1 FROM shares x WHERE x.bill_id = b.id AND x.participant_id <> p.id AND x.owed_cents > 0));

CREATE VIEW stamp_backfill_claim AS
  SELECT o.guild_id, o.person, o.kind, o.at, i.id AS item_id,
    lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      i.label, ' ', ''), '.', ''), ',', ''), '''', ''), '’', ''), '!', ''), '-', ''), '&', ''), '#', ''), '(', ''), ')', '')) AS item_key,
    EXISTS (SELECT 1 FROM item_claims x WHERE x.bill_item_id = i.id AND x.participant_id <> o.person) AS shared
  FROM stamp_backfill_outing o
  JOIN bill_items i ON i.bill_id = o.bill_id AND i.cents > 0
  JOIN item_claims c ON c.bill_item_id = i.id AND c.participant_id = o.person;

-- First Seat: the first outing.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'first-seat', MIN(at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM stamp_backfill_outing GROUP BY guild_id, person;

-- Host: the fifth bill hosted.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'host', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT guild_id, person, at, ROW_NUMBER() OVER (PARTITION BY guild_id, person ORDER BY at, bill_id) AS nth
  FROM stamp_backfill_outing WHERE kind = 'split' AND payer_id = person
) WHERE nth = 5;

-- Regular: the earliest third visit to any one place.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'regular', MIN(at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT guild_id, person, at, ROW_NUMBER() OVER (PARTITION BY guild_id, person, place_key ORDER BY at, bill_id) AS nth
  FROM stamp_backfill_outing WHERE place_key <> ''
) WHERE nth = 3 GROUP BY guild_id, person;

-- Traveler: the first visit to a tenth place.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'traveler', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT guild_id, person, at, ROW_NUMBER() OVER (PARTITION BY guild_id, person ORDER BY at, place_key) AS nth
  FROM (SELECT guild_id, person, place_key, MIN(at) AS at FROM stamp_backfill_outing WHERE place_key <> '' GROUP BY guild_id, person, place_key)
) WHERE nth = 10;

-- Hundred Flavors: the first try of a twenty-fifth item.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'hundred-flavors', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT guild_id, person, at, ROW_NUMBER() OVER (PARTITION BY guild_id, person ORDER BY at, item_key) AS nth
  FROM (SELECT guild_id, person, item_key, MIN(at) AS at FROM stamp_backfill_claim WHERE item_key <> '' GROUP BY guild_id, person, item_key)
) WHERE nth = 25;

-- Sharing the Sweet: the tenth shared item.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'sharing', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT guild_id, person, at, ROW_NUMBER() OVER (PARTITION BY guild_id, person ORDER BY at, item_id) AS nth
  FROM stamp_backfill_claim WHERE kind = 'split' AND shared = 1
) WHERE nth = 10;

-- Full Table: the first bill with 8 or more shares on it.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'full-table', MIN(at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM stamp_backfill_outing o
WHERE kind = 'split' AND (SELECT COUNT(*) FROM shares t WHERE t.bill_id = o.bill_id AND t.owed_cents > 0) >= 8
GROUP BY guild_id, person;

-- Word Kept: the tenth bill someone recorded their own payment on.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, person, 'word-kept', at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT b.guild_id, s.participant_id AS person, MIN(s.recorded_at) AS at,
    ROW_NUMBER() OVER (PARTITION BY b.guild_id, s.participant_id ORDER BY MIN(s.recorded_at), s.bill_id) AS nth
  FROM settlements s JOIN bills b ON b.id = s.bill_id
  WHERE b.status = 'confirmed' AND b.kind = 'split' AND s.recorded_by = s.participant_id
  GROUP BY b.guild_id, s.participant_id, s.bill_id
) WHERE nth = 10;

-- Clean Books: a bill where 3 or more people owed the payer and all have paid. One
-- row per debtor, the way outstanding() in src/db/settlements.ts reads a bill.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT guild_id, payer_id, 'clean-books', MIN(at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT guild_id, payer_id, COALESCE(MAX(last_paid), MAX(at)) AS at
  FROM (
    SELECT r.*,
      (SELECT COALESCE(SUM(y.cents), 0) FROM settlements y WHERE y.bill_id = r.bill_id AND y.participant_id = r.debtor) AS own,
      (SELECT COALESCE(SUM(y.cents), 0) FROM settlements y JOIN participants g ON g.bill_id = y.bill_id AND g.id = y.participant_id
       WHERE y.bill_id = r.bill_id AND g.kind = 'guest' AND g.added_by = r.debtor) AS direct,
      (SELECT MAX(y.recorded_at) FROM settlements y WHERE y.bill_id = r.bill_id) AS last_paid
    FROM (
      SELECT b.id AS bill_id, b.guild_id, b.payer_id,
        CASE WHEN q.kind = 'guest' AND q.added_by <> b.payer_id THEN q.added_by ELSE q.id END AS debtor,
        SUM(CASE WHEN s.pardoned = 1 THEN 0 ELSE s.owed_cents END) AS asked,
        COALESCE(b.confirmed_at, b.created_at) AS at
      FROM bills b
      JOIN shares s ON s.bill_id = b.id
      JOIN participants q ON q.bill_id = s.bill_id AND q.id = s.participant_id
      WHERE b.status = 'confirmed' AND b.kind = 'split'
      GROUP BY b.id, debtor
      HAVING debtor <> b.payer_id
    ) r
  )
  WHERE asked - direct > 0
  GROUP BY bill_id
  HAVING COUNT(*) >= 3 AND SUM(own < asked - direct) = 0
) GROUP BY guild_id, payer_id;

-- Magnanimous: forgiving anyone but yourself.
INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at)
SELECT b.guild_id, b.payer_id, 'magnanimous', MIN(COALESCE(b.confirmed_at, b.created_at)), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM shares s JOIN bills b ON b.id = s.bill_id
WHERE b.status = 'confirmed' AND b.kind = 'split' AND s.pardoned = 1 AND s.participant_id <> b.payer_id
GROUP BY b.guild_id, b.payer_id;

DROP VIEW stamp_backfill_claim;
DROP VIEW stamp_backfill_outing;
