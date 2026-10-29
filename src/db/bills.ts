import type { BillInput, Cents, LineItem, ParticipantId } from "../money/types";

export type BillStatus = "reading" | "draft" | "confirmed" | "superseded" | "deleted";

export interface Participant {
  billId: string;
  id: ParticipantId;
  kind: "member" | "guest";
  displayName: string;
  addedBy: ParticipantId | null;
}

export interface BillRow {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  payerId: ParticipantId;
  place: string | null;
  billDate: string | null;
  taxCents: Cents;
  tipCents: Cents;
  printedTotalCents: Cents | null;
  status: BillStatus;
  revision: number;
  createdAt: string;
  confirmedAt: string | null;
}

export type NewBill = Omit<BillRow, "revision" | "createdAt" | "confirmedAt">;

export interface NewItem {
  id: string;
  label: string;
  cents: Cents;
  source: "ocr" | "manual";
  confidence?: number | null;
}

interface BillDbRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  payer_id: string;
  place: string | null;
  bill_date: string | null;
  tax_cents: number;
  tip_cents: number;
  printed_total_cents: number | null;
  status: BillStatus;
  revision: number;
  created_at: string;
  confirmed_at: string | null;
}

interface ParticipantDbRow {
  bill_id: string;
  id: string;
  kind: "member" | "guest";
  display_name: string;
  added_by: string | null;
}

const BILL_COLUMNS = `id, guild_id, channel_id, message_id, payer_id, place, bill_date, tax_cents,
  tip_cents, printed_total_cents, status, revision, created_at, confirmed_at`;

function toBill(r: BillDbRow): BillRow {
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    messageId: r.message_id,
    payerId: r.payer_id,
    place: r.place,
    billDate: r.bill_date,
    taxCents: r.tax_cents,
    tipCents: r.tip_cents,
    printedTotalCents: r.printed_total_cents,
    status: r.status,
    revision: r.revision,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
  };
}

function toParticipant(r: ParticipantDbRow): Participant {
  return { billId: r.bill_id, id: r.id, kind: r.kind, displayName: r.display_name, addedBy: r.added_by };
}

// Plain code-unit order, not a locale collation, so the same set of ids always
// serialises the same way no matter where it runs.
function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

function bumpStatement(db: D1Database, billId: string): D1PreparedStatement {
  return db.prepare("UPDATE bills SET revision = revision + 1 WHERE id = ? RETURNING revision").bind(billId);
}

// Lands the writes and the revision bump in one batch, so no reader sees a
// changed split under an old revision.
async function mutate(db: D1Database, billId: string, writes: D1PreparedStatement[]): Promise<number> {
  const results = await db.batch<{ revision: number }>([...writes, bumpStatement(db, billId)]);
  const row = results[results.length - 1].results[0];
  if (!row) throw new Error(`bill ${billId} not found`);
  return row.revision;
}

export class BillNotDraftError extends Error {
  constructor(billId: string) {
    super(`bill ${billId} is not an open draft`);
    this.name = "BillNotDraftError";
  }
}

// Every draft-only write carries this condition in its own WHERE clause, with
// the bill id bound as ?1. A status check the caller made earlier is only a
// courtesy: Confirm can land between that check and the write, and the shares
// it froze must not then move under it.
const WHILE_DRAFT = "EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND status = 'draft')";

// The writes and the bump share one transaction and the same condition, so
// either all of them land on a draft or none of them do. An empty RETURNING
// means the bill was not a draft (or not there) when the batch ran.
async function mutateDraft(db: D1Database, billId: string, writes: D1PreparedStatement[]): Promise<number> {
  const bump = db
    .prepare("UPDATE bills SET revision = revision + 1 WHERE id = ?1 AND status = 'draft' RETURNING revision")
    .bind(billId);
  const results = await db.batch<{ revision: number }>([...writes, bump]);
  const row = results[results.length - 1].results[0];
  if (!row) throw new BillNotDraftError(billId);
  return row.revision;
}

export async function createBill(db: D1Database, b: NewBill): Promise<BillRow> {
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO bills (id, guild_id, channel_id, message_id, payer_id, place, bill_date, tax_cents,
         tip_cents, printed_total_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      b.id,
      b.guildId,
      b.channelId,
      b.messageId,
      b.payerId,
      b.place,
      b.billDate,
      b.taxCents,
      b.tipCents,
      b.printedTotalCents,
      b.status,
      createdAt,
    )
    .run();
  return { ...b, revision: 1, createdAt, confirmedAt: null };
}

export async function getBill(db: D1Database, id: string): Promise<BillRow | null> {
  const row = await db.prepare(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = ?`).bind(id).first<BillDbRow>();
  return row ? toBill(row) : null;
}

function itemsStatement(db: D1Database, billId: string) {
  return db.prepare("SELECT id, label, cents FROM bill_items WHERE bill_id = ? ORDER BY position").bind(billId);
}

function claimsStatement(db: D1Database, billId: string) {
  return db
    .prepare(
      `SELECT c.bill_item_id, c.participant_id
       FROM item_claims c JOIN bill_items i ON i.id = c.bill_item_id
       WHERE i.bill_id = ?`,
    )
    .bind(billId);
}

interface ItemDbRow {
  id: string;
  label: string;
  cents: number;
}

interface ClaimDbRow {
  bill_item_id: string;
  participant_id: string;
}

function assembleItems(items: ItemDbRow[], claims: ClaimDbRow[]): LineItem[] {
  const byItem = new Map<string, string[]>();
  for (const c of claims) {
    const list = byItem.get(c.bill_item_id);
    if (list) list.push(c.participant_id);
    else byItem.set(c.bill_item_id, [c.participant_id]);
  }
  return items.map((i) => ({
    id: i.id,
    label: i.label,
    cents: i.cents,
    claimedBy: sortedIds(byItem.get(i.id) ?? []),
  }));
}

export async function getBillItems(db: D1Database, billId: string): Promise<LineItem[]> {
  const [items, claims] = await db.batch([itemsStatement(db, billId), claimsStatement(db, billId)]);
  return assembleItems(items.results as ItemDbRow[], claims.results as ClaimDbRow[]);
}

function participantsStatement(db: D1Database, billId: string) {
  // rowid keeps chips in the order people joined the bill.
  return db
    .prepare("SELECT bill_id, id, kind, display_name, added_by FROM participants WHERE bill_id = ? ORDER BY rowid")
    .bind(billId);
}

export async function getParticipants(db: D1Database, billId: string): Promise<Participant[]> {
  const { results } = await participantsStatement(db, billId).all<ParticipantDbRow>();
  return results.map(toParticipant);
}

// A bill still being read is open too: a new /split supersedes it.
export async function openDraftInChannel(db: D1Database, channelId: string): Promise<BillRow | null> {
  const row = await db
    .prepare(
      `SELECT ${BILL_COLUMNS} FROM bills
       WHERE channel_id = ? AND status IN ('reading', 'draft')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(channelId)
    .first<BillDbRow>();
  return row ? toBill(row) : null;
}

// Only lines read less confidently than the bill's best line are worth pointing
// at: when every line came back equally sure, naming three of them would send
// the payer to check lines at random.
export async function getLeastConfidentItemIds(db: D1Database, billId: string, limit = 3): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM bill_items
       WHERE bill_id = ?1 AND source = 'ocr'
         AND confidence < (SELECT MAX(confidence) FROM bill_items WHERE bill_id = ?1 AND source = 'ocr')
       ORDER BY confidence, position LIMIT ?2`,
    )
    .bind(billId, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

// Supersedes only drafts older than the new bill, so two /split runs racing in
// one channel leave the later one open instead of killing each other. A bill
// that was confirmed once and reopened is not a stale draft: it may carry
// payments, and a new /split must not quietly void them.
export async function supersedeOlderDrafts(db: D1Database, channelId: string, newBillId: string): Promise<BillRow[]> {
  const { results } = await db
    .prepare(
      `UPDATE bills SET status = 'superseded', revision = revision + 1
       WHERE channel_id = ?1 AND status IN ('reading', 'draft') AND confirmed_at IS NULL
         AND rowid < (SELECT rowid FROM bills WHERE id = ?2)
       RETURNING ${BILL_COLUMNS}`,
    )
    .bind(channelId, newBillId)
    .all<BillDbRow>();
  return results.map(toBill);
}

export async function setBillMessage(db: D1Database, billId: string, channelId: string, messageId: string): Promise<void> {
  await db
    .prepare("UPDATE bills SET channel_id = ?, message_id = ? WHERE id = ?")
    .bind(channelId, messageId, billId)
    .run();
}

// D1's clock rather than the Worker's: every isolate compares against the same
// clock, so a refused request can never land after the holder's final read.
export async function claimEditLease(db: D1Database, billId: string, windowMs: number): Promise<boolean> {
  const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
  const { meta } = await db
    .prepare(
      `UPDATE bills SET edit_lease_until = ${now} + ?2
       WHERE id = ?1 AND (edit_lease_until IS NULL OR edit_lease_until < ${now})`,
    )
    .bind(billId, windowMs)
    .run();
  return meta.changes === 1;
}

export interface BillSnapshot {
  bill: BillRow;
  participants: Participant[];
  input: BillInput;
}

// One batch is one transaction, so the revision a page is handed always
// belongs to the items and claims it is shown beside.
export async function getBillSnapshot(db: D1Database, billId: string): Promise<BillSnapshot | null> {
  const [bill, items, claims, participants, pardoned] = await db.batch([
    db.prepare(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = ?`).bind(billId),
    itemsStatement(db, billId),
    claimsStatement(db, billId),
    participantsStatement(db, billId),
    db.prepare("SELECT participant_id FROM shares WHERE bill_id = ? AND pardoned = 1").bind(billId),
  ]);
  const billRow = (bill.results as BillDbRow[])[0];
  if (!billRow) return null;

  const people = (participants.results as ParticipantDbRow[]).map(toParticipant);
  return {
    bill: toBill(billRow),
    participants: people,
    input: {
      items: assembleItems(items.results as ItemDbRow[], claims.results as ClaimDbRow[]),
      taxCents: billRow.tax_cents,
      tipCents: billRow.tip_cents,
      payer: billRow.payer_id,
      participants: sortedIds(people.map((p) => p.id)),
      pardoned: sortedIds((pardoned.results as { participant_id: string }[]).map((p) => p.participant_id)),
    },
  };
}

export async function toSplitInput(db: D1Database, billId: string): Promise<BillInput> {
  const snapshot = await getBillSnapshot(db, billId);
  if (!snapshot) throw new Error(`bill ${billId} not found`);
  return snapshot.input;
}

export async function bumpRevision(db: D1Database, billId: string): Promise<number> {
  return mutate(db, billId, []);
}

export async function insertItems(db: D1Database, billId: string, items: NewItem[]): Promise<number> {
  const insert = db.prepare(
    `INSERT INTO bill_items (id, bill_id, label, cents, position, source, confidence)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM bill_items WHERE bill_id = ?), ?, ?)`,
  );
  return mutate(
    db,
    billId,
    items.map((i) => insert.bind(i.id, billId, i.label, i.cents, billId, i.source, i.confidence ?? null)),
  );
}

export async function addParticipant(db: D1Database, p: Participant, options: { draftOnly?: boolean } = {}): Promise<number> {
  return addParticipants(db, p.billId, [p], options);
}

// One batch for the lot, because the payer's roster picker can add 25 people
// inside an interaction that has to answer within three seconds. draftOnly is
// for people joining from Discord; seeding a bill being created skips it.
export async function addParticipants(
  db: D1Database,
  billId: string,
  people: Participant[],
  options: { draftOnly?: boolean } = {},
): Promise<number> {
  if (options.draftOnly) {
    const insert = db.prepare(
      `INSERT INTO participants (bill_id, id, kind, display_name, added_by)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${WHILE_DRAFT}
       ON CONFLICT (bill_id, id) DO NOTHING`,
    );
    return mutateDraft(
      db,
      billId,
      people.map((p) => insert.bind(billId, p.id, p.kind, p.displayName, p.addedBy)),
    );
  }
  const insert = db.prepare(
    `INSERT INTO participants (bill_id, id, kind, display_name, added_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (bill_id, id) DO NOTHING`,
  );
  return mutate(
    db,
    billId,
    people.map((p) => insert.bind(billId, p.id, p.kind, p.displayName, p.addedBy)),
  );
}

// Checks run before the batch because a batch commits whatever it contains: a
// bad id must be refused up front, not discovered after a stray row landed.
async function assertItemInBill(
  db: D1Database,
  billId: string,
  itemId: string,
  participantId: ParticipantId | null,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM bills WHERE id = ?1) AS bill,
         EXISTS (SELECT 1 FROM bill_items WHERE id = ?2 AND bill_id = ?1) AS item,
         ?3 IS NULL OR EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id = ?3) AS who`,
    )
    .bind(billId, itemId, participantId)
    .first<{ bill: number; item: number; who: number }>();
  if (!row?.bill) throw new Error(`bill ${billId} not found`);
  if (!row.item) throw new Error(`item ${itemId} is not on bill ${billId}`);
  if (!row.who) throw new Error(`${participantId} is not a participant of bill ${billId}`);
}

export async function addClaim(
  db: D1Database,
  billId: string,
  itemId: string,
  participantId: ParticipantId,
): Promise<number> {
  await assertItemInBill(db, billId, itemId, participantId);
  return mutate(db, billId, [
    db
      .prepare(
        `INSERT INTO item_claims (bill_item_id, participant_id)
         SELECT i.id, p.id FROM bill_items i JOIN participants p ON p.bill_id = i.bill_id
         WHERE i.id = ? AND i.bill_id = ? AND p.id = ?
         ON CONFLICT DO NOTHING`,
      )
      .bind(itemId, billId, participantId),
  ]);
}

// The claimant is deliberately not checked: removing a stale claim by someone
// who is no longer on the bill must stay possible.
export async function removeClaim(
  db: D1Database,
  billId: string,
  itemId: string,
  participantId: ParticipantId,
): Promise<number> {
  await assertItemInBill(db, billId, itemId, null);
  return mutate(db, billId, [
    db
      .prepare(
        `DELETE FROM item_claims
         WHERE bill_item_id = ? AND participant_id = ?
           AND bill_item_id IN (SELECT id FROM bill_items WHERE bill_id = ?)`,
      )
      .bind(itemId, participantId, billId),
  ]);
}

// The page's writes. Each is one row-level statement scoped to its bill, so
// two people claiming the same line at once both land, and an id that went
// stale between the caller's check and the write changes nothing. All of them
// refuse a bill that is no longer a draft with BillNotDraftError.

export async function setClaim(
  db: D1Database,
  billId: string,
  itemId: string,
  participantId: ParticipantId,
  claimed: boolean,
): Promise<number> {
  const write = claimed
    ? db.prepare(
        `INSERT INTO item_claims (bill_item_id, participant_id)
         SELECT i.id, p.id FROM bill_items i JOIN participants p ON p.bill_id = i.bill_id
         WHERE i.bill_id = ?1 AND i.id = ?2 AND p.id = ?3 AND ${WHILE_DRAFT}
         ON CONFLICT DO NOTHING`,
      )
    : db.prepare(
        `DELETE FROM item_claims
         WHERE bill_item_id = ?2 AND participant_id = ?3
           AND bill_item_id IN (SELECT id FROM bill_items WHERE bill_id = ?1) AND ${WHILE_DRAFT}`,
      );
  return mutateDraft(db, billId, [write.bind(billId, itemId, participantId)]);
}

export async function addItem(db: D1Database, billId: string, item: NewItem): Promise<number> {
  return mutateDraft(db, billId, [
    db
      .prepare(
        `INSERT INTO bill_items (id, bill_id, label, cents, position, source, confidence)
         SELECT ?2, ?1, ?3, ?4, (SELECT COALESCE(MAX(position) + 1, 0) FROM bill_items WHERE bill_id = ?1), ?5, ?6
         WHERE ${WHILE_DRAFT}`,
      )
      .bind(billId, item.id, item.label, item.cents, item.source, item.confidence ?? null),
  ]);
}

export async function editItem(
  db: D1Database,
  billId: string,
  itemId: string,
  change: { label?: string; cents?: number },
): Promise<number> {
  return mutateDraft(db, billId, [
    db
      .prepare(
        `UPDATE bill_items SET label = COALESCE(?3, label), cents = COALESCE(?4, cents)
         WHERE bill_id = ?1 AND id = ?2 AND ${WHILE_DRAFT}`,
      )
      .bind(billId, itemId, change.label ?? null, change.cents ?? null),
  ]);
}

// The line's claims go with it through the item_claims cascade.
export async function deleteItem(db: D1Database, billId: string, itemId: string): Promise<number> {
  return mutateDraft(db, billId, [
    db.prepare(`DELETE FROM bill_items WHERE bill_id = ?1 AND id = ?2 AND ${WHILE_DRAFT}`).bind(billId, itemId),
  ]);
}

export interface BillAmounts {
  taxCents?: number;
  tipCents?: number;
  // A percentage in hundredths of a percent, applied to the bill subtotal
  // inside the write so the tip matches the lines as they stand when it lands.
  tipBasisPoints?: number;
  printedTotalCents?: number | null;
}

export async function setBillAmounts(db: D1Database, billId: string, amounts: BillAmounts): Promise<number> {
  const sets: string[] = [];
  const values: (number | null)[] = [];
  const set = (sql: string, value: number | null) => {
    values.push(value);
    sets.push(sql.replace("?", `?${values.length + 1}`));
  };
  if (amounts.taxCents !== undefined) set("tax_cents = ?", amounts.taxCents);
  if (amounts.tipCents !== undefined) set("tip_cents = ?", amounts.tipCents);
  // Integer division truncates, and both factors are non-negative, so adding
  // half the divisor first rounds half up to the cent without a float. The
  // cast matters: a bound number may arrive as REAL, which would make the
  // division fractional.
  if (amounts.tipBasisPoints !== undefined) {
    set(
      `tip_cents = (SELECT (MAX(COALESCE(SUM(cents), 0), 0) * CAST(? AS INTEGER) + 5000) / 10000
                    FROM bill_items WHERE bill_id = ?1)`,
      amounts.tipBasisPoints,
    );
  }
  if (amounts.printedTotalCents !== undefined) set("printed_total_cents = ?", amounts.printedTotalCents);
  if (sets.length === 0) throw new Error("no amounts to set");

  return mutateDraft(db, billId, [
    db.prepare(`UPDATE bills SET ${sets.join(", ")} WHERE id = ?1 AND status = 'draft'`).bind(billId, ...values),
  ]);
}
