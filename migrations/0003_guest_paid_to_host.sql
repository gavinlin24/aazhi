-- When a guest settled up with the member who added them. Bookkeeping between
-- the two of them only: the member still owes the payer the guest's share, so
-- this never counts as a payment. A guest who pays the payer directly is a
-- settlement row instead, because that money does reach the payer.
ALTER TABLE shares ADD COLUMN paid_to_host_at TEXT;
