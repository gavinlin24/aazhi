-- A dish's add-ons, e.g. "Extra patty +$3.00, No onions": read from under it
-- on the receipt, or as the payer edited them. Display only. Any charge it
-- names is already in the line's cents.
ALTER TABLE bill_items ADD COLUMN note TEXT;
