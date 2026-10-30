-- Reads for /profile. A person is a Discord id on many bills, so "this person's
-- bills" needs an index that starts at the id; the primary key starts at the bill.
CREATE INDEX idx_participants_person ON participants (id, bill_id);

-- A board reads every confirmed bill in one server.
CREATE INDEX idx_bills_guild_status ON bills (guild_id, status);
