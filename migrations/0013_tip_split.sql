-- How the tip is divided: 'items' follows what each person had, 'even' gives
-- everyone with a line one equal part. The default is 'items' on purpose, though
-- new bills are even. It keeps every existing bill's amounts, and it covers a
-- bill the old Worker makes between this migration and the new deploy, which
-- that Worker confirms by items. createBill writes 'even' itself.
ALTER TABLE bills ADD COLUMN tip_split TEXT NOT NULL DEFAULT 'items' CHECK (tip_split IN ('items', 'even'));
