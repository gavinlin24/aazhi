-- How the tip is divided: 'items' follows what each person had, 'even' gives
-- everyone with a line one equal part. Every existing bill keeps 'items', and
-- the old Worker names its columns, so it carries on until the new one lands.
ALTER TABLE bills ADD COLUMN tip_split TEXT NOT NULL DEFAULT 'items' CHECK (tip_split IN ('items', 'even'));
