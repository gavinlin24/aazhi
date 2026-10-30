import { reconciles } from "../extract/claude";
import { groupByDebtor, groupOf, paidByDebtor, type Diner } from "../money/debtors";
import { splitBill } from "../money/split";
import type { BillInput, Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";
import { debtorOfSql, debtorSql, groupPaidSql } from "./debt";

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

interface SnapshotBillDbRow extends BillDbRow {
  has_payments: number;
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
  // Whether anyone has paid against this bill, which is what stops the payer
  // being handed to someone else.
  hasPayments: boolean;
  // Everyone who answers for a share and has a payment against it: their own,
  // or a guest of theirs paying the payer directly.
  paid: ParticipantId[];
  // Guests who paid the payer directly: a payment recorded against the guest.
  paidToPayer: ParticipantId[];
  // Guests who paid the member who added them. Bookkeeping only, and only
  // while that member is not the payer, since then the two are one.
  paidToHost: ParticipantId[];
}

function snapshotStatements(db: D1Database, billId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT ${BILL_COLUMNS}, EXISTS (SELECT 1 FROM settlements WHERE bill_id = bills.id) AS has_payments
         FROM bills WHERE id = ?`,
      )
      .bind(billId),
    itemsStatement(db, billId),
    claimsStatement(db, billId),
    participantsStatement(db, billId),
    // The lists in one statement, tagged, so a snapshot stays a fixed number
    // of reads however much the bill holds.
    db
      .prepare(
        `SELECT 'pardoned' AS list, participant_id FROM shares WHERE bill_id = ?1 AND pardoned = 1
         UNION SELECT 'paid', ${debtorSql("q", "b.payer_id")} FROM settlements x
           JOIN participants q ON q.bill_id = x.bill_id AND q.id = x.participant_id JOIN bills b ON b.id = x.bill_id
           WHERE x.bill_id = ?1
         UNION SELECT 'paidToPayer', x.participant_id FROM settlements x
           JOIN participants q ON q.bill_id = x.bill_id AND q.id = x.participant_id
           WHERE x.bill_id = ?1 AND q.kind = 'guest'
         UNION SELECT 'paidToHost', s.participant_id FROM shares s
           JOIN participants q ON q.bill_id = s.bill_id AND q.id = s.participant_id JOIN bills b ON b.id = s.bill_id
           WHERE s.bill_id = ?1 AND s.paid_to_host_at IS NOT NULL AND q.kind = 'guest' AND q.added_by <> b.payer_id
         ORDER BY 1, 2`,
      )
      .bind(billId),
  ];
}

// One batch is one transaction, so the revision a page is handed always
// belongs to the items and claims it is shown beside.
export async function getBillSnapshot(db: D1Database, billId: string): Promise<BillSnapshot | null> {
  return assembleSnapshot(await db.batch(snapshotStatements(db, billId)));
}

function assembleSnapshot(results: D1Result[]): BillSnapshot | null {
  const [bill, items, claims, participants, lists] = results as [D1Result, D1Result, D1Result, D1Result, D1Result];
  const billRow = (bill.results as SnapshotBillDbRow[])[0];
  if (!billRow) return null;

  const people = (participants.results as ParticipantDbRow[]).map(toParticipant);
  type List = "pardoned" | "paid" | "paidToPayer" | "paidToHost";
  const tagged = lists.results as { list: List; participant_id: string }[];
  const listed = (which: List) => tagged.filter((r) => r.list === which).map((r) => r.participant_id);
  return {
    bill: toBill(billRow),
    participants: people,
    input: {
      items: assembleItems(items.results as ItemDbRow[], claims.results as ClaimDbRow[]),
      taxCents: billRow.tax_cents,
      tipCents: billRow.tip_cents,
      payer: billRow.payer_id,
      participants: sortedIds(people.map((p) => p.id)),
      pardoned: sortedIds(listed("pardoned")),
    },
    hasPayments: billRow.has_payments === 1,
    paid: listed("paid"),
    paidToPayer: listed("paidToPayer"),
    paidToHost: listed("paidToHost"),
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

export class BillChangedError extends Error {
  constructor(billId: string) {
    super(`bill ${billId} changed since the revision the caller saw`);
    this.name = "BillChangedError";
  }
}

export class BillNotConfirmedError extends Error {
  constructor(billId: string) {
    super(`bill ${billId} is not confirmed`);
    this.name = "BillNotConfirmedError";
  }
}

export class BillGoneError extends Error {
  constructor(billId: string) {
    super(`bill ${billId} is already gone`);
    this.name = "BillGoneError";
  }
}

export class NobodyClaimedError extends Error {
  constructor(billId: string) {
    super(`nobody has claimed anything on bill ${billId}`);
    this.name = "NobodyClaimedError";
  }
}

export class PaymentsChangedError extends Error {
  constructor(billId: string) {
    super(`payments on bill ${billId} changed since they were shown`);
    this.name = "PaymentsChangedError";
  }
}

export class PaymentsRecordedError extends Error {
  constructor(billId: string) {
    super(`bill ${billId} already has payments recorded against its payer`);
    this.name = "PaymentsRecordedError";
  }
}

export class NotOnRosterError extends Error {
  constructor(billId: string, who: ParticipantId) {
    super(`${who} is not a member on the roster of bill ${billId}`);
    this.name = "NotOnRosterError";
  }
}

interface ShareDbRow {
  participant_id: string;
  subtotal_cents: number;
  tax_cents: number;
  tip_cents: number;
  owed_cents: number;
  pardoned: number;
}

export interface Settled {
  participant: ParticipantId;
  cents: Cents;
}

function sharesStatement(db: D1Database, billId: string) {
  return db
    .prepare(
      `SELECT participant_id, subtotal_cents, tax_cents, tip_cents, owed_cents, pardoned
       FROM shares WHERE bill_id = ? ORDER BY participant_id`,
    )
    .bind(billId);
}

function settledStatement(db: D1Database, billId: string) {
  return db
    .prepare(
      `SELECT participant_id, SUM(cents) AS cents FROM settlements
       WHERE bill_id = ? GROUP BY participant_id ORDER BY participant_id`,
    )
    .bind(billId);
}

function toShares(result: D1Result): Share[] {
  return (result.results as ShareDbRow[]).map((r) => ({
    participant: r.participant_id,
    subtotalCents: r.subtotal_cents,
    taxCents: r.tax_cents,
    tipCents: r.tip_cents,
    owedCents: r.owed_cents,
    pardoned: r.pardoned === 1,
  }));
}

function toSettled(result: D1Result): Settled[] {
  return (result.results as { participant_id: string; cents: number }[]).map((r) => ({
    participant: r.participant_id,
    cents: r.cents,
  }));
}

// The numbers frozen at the last confirm, not a recomputation.
export async function getShares(db: D1Database, billId: string): Promise<Share[]> {
  return toShares(await sharesStatement(db, billId).all());
}

// What each person has paid towards this bill so far, summed over every
// settlement row, since partial payments are ordinary.
export async function getSettled(db: D1Database, billId: string): Promise<Settled[]> {
  return toSettled(await settledStatement(db, billId).all());
}

// A share is clear when the payments against the group that answers for it
// reach everything that group is asked for after pardons: the debtor's own
// share and their guests', so a guest's row settles with the member who added
// them, whoever of the two paid. That is never stored as a decision of its
// own. settled_at only remembers when it first became true (time-to-settle is
// a statistic), so every write that moves either side re-derives it in the
// same batch. The derivation reads nothing but the rows as they stand, so
// running it after a write that matched nothing changes nothing. The payer
// owes nobody, so their own row never settles. `who` picks the group to
// re-derive, by its debtor or any guest in it; null re-derives the whole bill.
export function settledAtStatement(
  db: D1Database,
  billId: string,
  who: ParticipantId | null,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `WITH debt AS (
         SELECT q.id AS participant, ${debtorSql("q", "b.payer_id")} AS debtor
         FROM participants q JOIN bills b ON b.id = q.bill_id WHERE q.bill_id = ?1
       ),
       owing AS (
         SELECT d.debtor,
           SUM(CASE WHEN s.pardoned = 1 THEN 0 ELSE s.owed_cents END) AS owed,
           (SELECT COALESCE(SUM(x.cents), 0) FROM settlements x JOIN debt e ON e.participant = x.participant_id
            WHERE x.bill_id = ?1 AND e.debtor = d.debtor) AS paid
         FROM shares s JOIN debt d ON d.participant = s.participant_id
         WHERE s.bill_id = ?1
         GROUP BY d.debtor
       )
       UPDATE shares SET settled_at = CASE
         WHEN o.debtor = (SELECT payer_id FROM bills WHERE id = ?1) THEN NULL
         WHEN o.paid >= o.owed THEN COALESCE(shares.settled_at, ?3)
         ELSE NULL END
       FROM debt d JOIN owing o ON o.debtor = d.debtor
       WHERE shares.bill_id = ?1 AND shares.participant_id = d.participant
         AND (?2 IS NULL OR d.debtor = (SELECT debtor FROM debt WHERE participant = ?2))`,
    )
    .bind(billId, who, now);
}

export interface AmountChange {
  participant: ParticipantId;
  wasCents: Cents;
  nowCents: Cents;
  settledCents: Cents;
}

// Only someone who has already paid needs telling: anyone else just sees
// their new number before they pay it. Shared by reopen and re-confirm so
// both say the same thing about the same difference. Amounts are what each
// paying debtor answers for after pardons, guests included, since that is
// what their payments were measured against, less whatever their guests paid
// the payer directly, which was never theirs to pay.
export function amountChanges(
  frozen: Share[],
  now: SplitResult,
  settled: Settled[],
  diners: Diner[],
  payer: ParticipantId,
): AmountChange[] {
  const was = groupByDebtor(frozen, diners, payer);
  const owed = groupByDebtor(now.shares, diners, payer);
  return [...paidByDebtor(settled, diners, payer)].flatMap(([participant, { ownCents, directCents }]) => {
    const before = groupOf(was, participant);
    if (ownCents <= 0 || before === undefined) return [];
    const wasCents = before.owedCents - directCents;
    const nowCents = (groupOf(owed, participant)?.owedCents ?? 0) - directCents;
    return wasCents === nowCents ? [] : [{ participant, wasCents, nowCents, settledCents: ownCents }];
  });
}

export type ConfirmRefusal = "stale" | "unreconciled" | "not-payer" | "not-draft" | "unclaimed";
export type ConfirmResult = { ok: true; changes: AmountChange[] } | { ok: false; reason: ConfirmRefusal };

function refused(reason: ConfirmRefusal): ConfirmResult {
  return { ok: false, reason };
}

// `revision` is the one the payer's Confirm was drawn from. Every check runs
// against one consistent read, and every write of the freeze repeats the
// draft-at-that-revision condition in its own WHERE: a batch is one
// transaction, but a write that matches nothing does not roll the others
// back, so a guard on the last statement alone would still let shares land
// for a bill that changed after the checks.
export async function confirmBill(
  db: D1Database,
  billId: string,
  revision: number,
  actor: ParticipantId,
): Promise<ConfirmResult> {
  const results = await db.batch([...snapshotStatements(db, billId), sharesStatement(db, billId), settledStatement(db, billId)]);
  const snapshot = assembleSnapshot(results);
  if (!snapshot || snapshot.bill.status !== "draft") return refused("not-draft");
  const { bill, input } = snapshot;
  if (actor !== bill.payerId) return refused("not-payer");
  if (bill.revision !== revision) return refused("stale");
  if (!reconciles({ items: input.items, taxCents: bill.taxCents, printedTotalCents: bill.printedTotalCents }).ok) {
    return refused("unreconciled");
  }
  const split = splitBill(input);
  // With every line claimed the claimed slice is the whole bill, so the
  // frozen shares sum to the printed total.
  if (!split.fullyClaimed) return refused("unclaimed");

  // A bill confirmed before carries its old frozen rows; comparing against
  // them is what lets a re-confirm say out loud whose amount moved.
  const changes = amountChanges(toShares(results[5]!), split, toSettled(results[6]!), snapshot.participants, bill.payerId);

  const atRevision = "EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND status = 'draft' AND revision = ?2)";
  // A pardon flag survives a re-confirm. Whether someone is still clear under
  // their new amount is re-derived from their payments right after, in the
  // same batch, rather than carried over from the old amount.
  const upsert = db.prepare(
    `INSERT INTO shares (bill_id, participant_id, subtotal_cents, tax_cents, tip_cents, owed_cents)
     SELECT ?1, ?3, ?4, ?5, ?6, ?7 WHERE ${atRevision}
     ON CONFLICT (bill_id, participant_id) DO UPDATE SET
       subtotal_cents = excluded.subtotal_cents,
       tax_cents = excluded.tax_cents,
       tip_cents = excluded.tip_cents,
       owed_cents = excluded.owed_cents`,
  );
  const now = new Date().toISOString();
  const freeze = db
    .prepare(
      `UPDATE bills SET status = 'confirmed', confirmed_at = ?3, revision = revision + 1
       WHERE id = ?1 AND status = 'draft' AND revision = ?2 RETURNING revision`,
    )
    .bind(billId, revision, now);
  const written = await db.batch([
    ...split.shares.map((s) => upsert.bind(billId, revision, s.participant, s.subtotalCents, s.taxCents, s.tipCents, s.owedCents)),
    settledAtStatement(db, billId, null, now),
    freeze,
  ]);
  if (written[written.length - 1]!.results.length === 0) {
    const now = await getBill(db, billId);
    return refused(now?.status === "draft" ? "stale" : "not-draft");
  }
  return { ok: true, changes };
}

// Back to draft with every claim kept, and the share rows kept too so a
// re-confirm re-applies their pardon flags. The read rides in the same batch
// as the status change, so the changes describe exactly the bill reopened.
export async function reopenBill(db: D1Database, billId: string): Promise<AmountChange[]> {
  const [reopened, ...rest] = await db.batch([
    db
      .prepare("UPDATE bills SET status = 'draft', revision = revision + 1 WHERE id = ? AND status = 'confirmed' RETURNING revision")
      .bind(billId),
    ...snapshotStatements(db, billId),
    sharesStatement(db, billId),
    settledStatement(db, billId),
  ]);
  if (reopened!.results.length === 0) throw new BillNotConfirmedError(billId);
  const snapshot = assembleSnapshot(rest)!;
  return amountChanges(toShares(rest[5]!), splitBill(snapshot.input), toSettled(rest[6]!), snapshot.participants, snapshot.bill.payerId);
}

// A soft delete: claims, shares and settlements stay on record, the bill
// just stops being live anywhere. `settledCents` is the payment total the
// payer was shown when they agreed to discard it; a payment recorded since
// means they agreed to something else, so the check sits in the write itself.
export async function deleteBill(db: D1Database, billId: string, settledCents: Cents): Promise<void> {
  const { meta } = await db
    .prepare(
      `UPDATE bills SET status = 'deleted', revision = revision + 1
       WHERE id = ?1 AND status IN ('draft', 'confirmed')
         AND (SELECT COALESCE(SUM(cents), 0) FROM settlements WHERE bill_id = ?1) = ?2`,
    )
    .bind(billId, settledCents)
    .run();
  if (meta.changes === 1) return;
  const bill = await getBill(db, billId);
  if (bill?.status === "draft" || bill?.status === "confirmed") throw new PaymentsChangedError(billId);
  throw new BillGoneError(billId);
}

// Every line nobody is on goes to everyone who claimed anything, split like
// any shared dish. With `revision`, only the bill the payer was offered this
// on is touched; anything that changed since means the offer is void.
export async function splitOrphansEvenly(
  db: D1Database,
  billId: string,
  options: { revision?: number } = {},
): Promise<number> {
  const claimants = await db
    .prepare(
      `SELECT COUNT(DISTINCT c.participant_id) AS n
       FROM item_claims c JOIN bill_items i ON i.id = c.bill_item_id WHERE i.bill_id = ?`,
    )
    .bind(billId)
    .first<{ n: number }>();
  if (!claimants?.n) throw new NobodyClaimedError(billId);

  const open = "status = 'draft' AND (?2 IS NULL OR revision = ?2)";
  // SQLite reads the whole SELECT before inserting when it reads the table it
  // inserts into, so a line's first new claim does not hide it from the rest.
  const [, bump] = await db.batch<{ revision: number }>([
    db
      .prepare(
        `INSERT INTO item_claims (bill_item_id, participant_id)
         SELECT i.id, p.id FROM bill_items i JOIN participants p ON p.bill_id = i.bill_id
         WHERE i.bill_id = ?1
           AND NOT EXISTS (SELECT 1 FROM item_claims x WHERE x.bill_item_id = i.id)
           AND EXISTS (
             SELECT 1 FROM item_claims y JOIN bill_items j ON j.id = y.bill_item_id
             WHERE j.bill_id = ?1 AND y.participant_id = p.id)
           AND EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND ${open})
         ON CONFLICT DO NOTHING`,
      )
      .bind(billId, options.revision ?? null),
    db
      .prepare(`UPDATE bills SET revision = revision + 1 WHERE id = ?1 AND ${open} RETURNING revision`)
      .bind(billId, options.revision ?? null),
  ]);
  const row = bump!.results[0];
  if (row) return row.revision;
  const bill = await getBill(db, billId);
  throw bill?.status === "draft" ? new BillChangedError(billId) : new BillNotDraftError(billId);
}

// For when somebody else's card went down. Only a member can be the payer: a
// guest has no account to collect into. Nobody leaves a roster, so the check
// up front still holds when the write lands. A payment, though, can land at
// any time, and every recorded one was paid to the current payer; moving the
// bill would quietly credit it to someone else, so that check is in the write.
export async function reassignPayer(db: D1Database, billId: string, to: ParticipantId): Promise<number> {
  const target = await db
    .prepare("SELECT kind FROM participants WHERE bill_id = ? AND id = ?")
    .bind(billId, to)
    .first<{ kind: string }>();
  if (target?.kind !== "member") throw new NotOnRosterError(billId, to);
  const open = "status = 'draft' AND NOT EXISTS (SELECT 1 FROM settlements WHERE bill_id = ?1)";
  const [, moved] = await db.batch<{ revision: number }>([
    db
      .prepare(`UPDATE shares SET pardoned = 0 WHERE bill_id = ?1 AND EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND payer_id <> ?2 AND ${open})`)
      .bind(billId, to),
    db.prepare(`UPDATE bills SET payer_id = ?2, revision = revision + 1 WHERE id = ?1 AND ${open} RETURNING revision`).bind(billId, to),
  ]);
  const row = moved!.results[0];
  if (row) return row.revision;
  const bill = await getBill(db, billId);
  throw bill?.status === "draft" ? new PaymentsRecordedError(billId) : new BillNotDraftError(billId);
}

// "no-guest": there is no guest by that id on the bill (any more). "paid": the
// group the guest belongs to has a payment, which was measured against a total
// that counted the guest.
export type GuestRefusal = "not-member" | "name-taken" | "no-guest" | "paid";

export class GuestRefusedError extends Error {
  constructor(readonly reason: GuestRefusal) {
    super(`guest refused: ${reason}`);
    this.name = "GuestRefusedError";
  }
}

// A refused guest write tells the caller nothing, so this reads the bill as
// it is now. `otherwise` is the write's own rule, the one left when the bill
// is a draft and the guest is still there.
async function guestRefusal(db: D1Database, billId: string, guestId: ParticipantId, otherwise: GuestRefusal): Promise<never> {
  const bill = await getBill(db, billId);
  if (bill?.status !== "draft") throw new BillNotDraftError(billId);
  const guest = await db
    .prepare("SELECT 1 AS found FROM participants WHERE bill_id = ? AND id = ? AND kind = 'guest'")
    .bind(billId, guestId)
    .first<{ found: number }>();
  throw new GuestRefusedError(guest ? otherwise : "no-guest");
}

// Nobody else on the bill may answer to the same name: two people with one
// name would make every row and payment ambiguous. lower() folds ASCII only;
// the caller compares the full names up front.
const NAME_FREE = "NOT EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id <> ?2 AND lower(trim(display_name)) = lower(?3))";

// A guest is a label on one bill: a generated id, no person behind it, and
// the member who added them answering for their share. Every rule sits in the
// write, so a confirm or a same-named guest landing first changes nothing.
export async function addGuest(
  db: D1Database,
  billId: string,
  guest: { id: ParticipantId; displayName: string; addedBy: ParticipantId },
): Promise<number> {
  const [inserted, bump] = await db.batch<{ revision: number }>([
    db
      .prepare(
        `INSERT INTO participants (bill_id, id, kind, display_name, added_by)
         SELECT ?1, ?2, 'guest', ?3, ?4
         WHERE ${WHILE_DRAFT}
           AND EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id = ?4 AND kind = 'member')
           AND ${NAME_FREE}
         RETURNING id`,
      )
      .bind(billId, guest.id, guest.displayName, guest.addedBy),
    db
      .prepare(
        `UPDATE bills SET revision = revision + 1
         WHERE id = ?1 AND status = 'draft' AND EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id = ?2)
         RETURNING revision`,
      )
      .bind(billId, guest.id),
  ]);
  const row = bump!.results[0];
  if (inserted!.results.length === 1 && row) return row.revision;

  const bill = await getBill(db, billId);
  if (bill?.status !== "draft") throw new BillNotDraftError(billId);
  const adder = await db
    .prepare("SELECT kind FROM participants WHERE bill_id = ? AND id = ?")
    .bind(billId, guest.addedBy)
    .first<{ kind: string }>();
  throw new GuestRefusedError(adder?.kind === "member" ? "name-taken" : "not-member");
}

// The bump goes first in both guest writes below, so it judges the bill
// exactly as the write after it does, before anything changes.

export async function renameGuest(
  db: D1Database,
  billId: string,
  guestId: ParticipantId,
  displayName: string,
): Promise<number> {
  const allowed = `${WHILE_DRAFT} AND EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id = ?2 AND kind = 'guest') AND ${NAME_FREE}`;
  const [bump] = await db.batch<{ revision: number }>([
    db.prepare(`UPDATE bills SET revision = revision + 1 WHERE id = ?1 AND ${allowed} RETURNING revision`).bind(billId, guestId, displayName),
    db.prepare(`UPDATE participants SET display_name = ?3 WHERE bill_id = ?1 AND id = ?2 AND ${allowed}`).bind(billId, guestId, displayName),
  ]);
  const row = bump!.results[0];
  return row ? row.revision : guestRefusal(db, billId, guestId, "name-taken");
}

// Takes the guest off with their claims, and with the share row a reopened
// bill kept for them. Refused once their group has a payment: a re-confirm
// tells a person who paid how their amount moved by comparing against the
// shares they paid on, and the guest's would be gone.
export async function removeGuest(db: D1Database, billId: string, guestId: ParticipantId): Promise<number> {
  const allowed = `${WHILE_DRAFT}
    AND EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id = ?2 AND kind = 'guest')
    AND ${groupPaidSql("?1", debtorOfSql("?1", "?2"))} = 0`;
  // Children first: a share row points at its participant.
  const [bump] = await db.batch<{ revision: number }>([
    db.prepare(`UPDATE bills SET revision = revision + 1 WHERE id = ?1 AND ${allowed} RETURNING revision`).bind(billId, guestId),
    db
      .prepare(`DELETE FROM item_claims WHERE participant_id = ?2 AND bill_item_id IN (SELECT id FROM bill_items WHERE bill_id = ?1) AND ${allowed}`)
      .bind(billId, guestId),
    db.prepare(`DELETE FROM shares WHERE bill_id = ?1 AND participant_id = ?2 AND ${allowed}`).bind(billId, guestId),
    db.prepare(`DELETE FROM participants WHERE bill_id = ?1 AND id = ?2 AND ${allowed}`).bind(billId, guestId),
  ]);
  const row = bump!.results[0];
  return row ? row.revision : guestRefusal(db, billId, guestId, "paid");
}

// "payer": the share is the payer's own, so there is nobody to forgive.
// "paid": the group answering for it has a payment, and forgiving on top of a
// payment would make "what is left" two rules instead of one.
export type PardonRefusal = "not-confirmed" | "no-share" | "payer" | "paid" | "changed";

export class PardonRefusedError extends Error {
  constructor(readonly reason: PardonRefusal) {
    super(`pardon refused: ${reason}`);
    this.name = "PardonRefusedError";
  }
}

// Only on a confirmed bill, because a pardon waives an amount that is frozen.
// The payer absorbs it: nobody else's share is touched, only the flag, and
// whether the person is now clear is re-derived in the same batch. Null means
// the flag already said that, so nothing changed and there is nothing to tell.
export async function setPardon(
  db: D1Database,
  billId: string,
  participantId: ParticipantId,
  pardoned: boolean,
): Promise<number | null> {
  const debtor = debtorOfSql("?1", "?2");
  const allowed = `EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND status = 'confirmed' AND payer_id <> ${debtor})
    AND ${groupPaidSql("?1", debtor)} = 0`;
  // The bump goes first so it sees the flag before the change, as the share
  // write does; both then agree on whether this write changes anything.
  const [bump, changed] = await db.batch<{ revision: number }>([
    db
      .prepare(
        `UPDATE bills SET revision = revision + 1
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM shares WHERE bill_id = ?1 AND participant_id = ?2 AND pardoned <> ?3) AND ${allowed}
         RETURNING revision`,
      )
      .bind(billId, participantId, pardoned ? 1 : 0),
    db
      .prepare(
        `UPDATE shares SET pardoned = ?3
         WHERE bill_id = ?1 AND participant_id = ?2 AND pardoned <> ?3 AND ${allowed} RETURNING participant_id`,
      )
      .bind(billId, participantId, pardoned ? 1 : 0),
    settledAtStatement(db, billId, null, new Date().toISOString()),
  ]);
  const row = bump!.results[0];
  if (changed!.results.length === 1 && row) return row.revision;

  const now = await db
    .prepare(
      `SELECT b.status, b.payer_id, ${debtorOfSql("?1", "?2")} AS debtor, s.participant_id IS NOT NULL AS has_share,
         s.pardoned, ${groupPaidSql("?1", debtorOfSql("?1", "?2"))} > 0 AS paid
       FROM bills b
       LEFT JOIN shares s ON s.bill_id = b.id AND s.participant_id = ?2
       WHERE b.id = ?1`,
    )
    .bind(billId, participantId)
    .first<{ status: string; payer_id: string; debtor: string | null; has_share: number; pardoned: number | null; paid: number }>();
  if (now?.status !== "confirmed") throw new PardonRefusedError("not-confirmed");
  if (!now.has_share) throw new PardonRefusedError("no-share");
  if (now.debtor === now.payer_id) throw new PardonRefusedError("payer");
  if (now.paid) throw new PardonRefusedError("paid");
  if (now.pardoned === (pardoned ? 1 : 0)) return null;
  throw new PardonRefusedError("changed");
}
