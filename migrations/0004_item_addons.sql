-- A dish's add-ons as JSON, e.g. [{"label":"Extra patty","cents":300}]: read
-- from under it on the receipt, or as the payer edited them. cents already
-- includes them, so the money code never reads this column.
ALTER TABLE bill_items ADD COLUMN addons TEXT CHECK (addons IS NULL OR json_valid(addons));
