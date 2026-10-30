-- What was printed under a dish: its modifiers and special requests, e.g.
-- "Extra patty +$3.00, No onions". Display only. Any charge it names is
-- already in the line's cents.
ALTER TABLE bill_items ADD COLUMN note TEXT;
