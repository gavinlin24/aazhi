// The debtor rule in SQL, for the writes that must check it in their own
// WHERE. Each mirrors src/money/debtors.ts; every argument is an SQL
// expression, and each subquery uses aliases of its own so it can sit inside
// another without capturing the outer query's columns.

// The SQL twin of debtorOf, for participant alias `q` on a bill whose payer
// is `payer`.
export function debtorSql(q: string, payer: string): string {
  return `(CASE WHEN ${q}.kind = 'guest' AND ${q}.added_by <> ${payer} THEN ${q}.added_by ELSE ${q}.id END)`;
}

// Who answers for participant `who` on bill `bill`.
export function debtorOfSql(bill: string, who: string): string {
  return `(SELECT ${debtorSql("dq", "dbl.payer_id")} FROM participants dq JOIN bills dbl ON dbl.id = dq.bill_id
    WHERE dq.bill_id = ${bill} AND dq.id = ${who})`;
}

// What `debtor` is asked for on `bill`: every share they answer for, their
// own and their guests', where a pardoned share asks for nothing.
export function groupOwedSql(bill: string, debtor: string): string {
  return `(SELECT COALESCE(SUM(CASE WHEN g.pardoned = 1 THEN 0 ELSE g.owed_cents END), 0)
    FROM shares g JOIN participants gq ON gq.bill_id = g.bill_id AND gq.id = g.participant_id
    JOIN bills gb ON gb.id = g.bill_id
    WHERE g.bill_id = ${bill} AND ${debtorSql("gq", "gb.payer_id")} = ${debtor})`;
}

// Every payment against what `debtor` is asked for: their own, and any their
// guests made to the payer directly. Partial payments are ordinary, so every
// row counts.
export function groupPaidSql(bill: string, debtor: string): string {
  return `(SELECT COALESCE(SUM(x.cents), 0)
    FROM settlements x JOIN participants xq ON xq.bill_id = x.bill_id AND xq.id = x.participant_id
    JOIN bills xb ON xb.id = x.bill_id
    WHERE x.bill_id = ${bill} AND ${debtorSql("xq", "xb.payer_id")} = ${debtor})`;
}

// Only what `debtor` paid themselves.
export function ownPaidSql(bill: string, debtor: string): string {
  return `(SELECT COALESCE(SUM(y.cents), 0) FROM settlements y WHERE y.bill_id = ${bill} AND y.participant_id = ${debtor})`;
}
