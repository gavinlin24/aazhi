import type { Cents, ParticipantId } from "../money/types";
import { BillNotConfirmedError, settledAtStatement } from "./bills";
import { debtorOfSql, debtorSql, groupOwedSql, groupPaidSql, ownPaidSql } from "./debt";

export interface Settlement {
  id: string;
  billId: string;
  participant: ParticipantId;
  cents: Cents;
  recordedAt: string;
  recordedBy: ParticipantId;
}

// A debtor's standing on one bill. What their guests paid the payer directly
// is taken off `owedCents` rather than added to `settledCents`, so "you've
// paid" only ever counts the person's own payments; the difference, what is
// left, is the same either way.
export interface Outstanding {
  participant: ParticipantId;
  owedCents: Cents;
  settledCents: Cents;
}

export interface LedgerRow {
  participant: ParticipantId;
  displayName: string;
  // A guest the payer added owes them directly, so has a row of their own,
  // always for one bill; `place` is that bill's, to tell the row apart.
  kind: "member" | "guest";
  place: string | null;
  owedCents: Cents; // across bills, after pardons
  settledCents: Cents;
  billCount: number;
}

// "clear": nothing left to pay (paid in full, or pardoned). "stale": a
// paid-it-all drawn from a remaining amount that has changed since.
export type SettlementRefusal = "not-confirmed" | "not-allowed" | "payer" | "no-share" | "not-positive" | "clear" | "stale" | "over";

export class SettlementRefusedError extends Error {
  constructor(
    readonly reason: SettlementRefusal,
    readonly remainingCents: Cents | null = null,
  ) {
    super(`settlement refused: ${reason}`);
    this.name = "SettlementRefusedError";
  }
}

export class SettlementGoneError extends Error {
  constructor(id: string) {
    super(`settlement ${id} is already gone`);
    this.name = "SettlementGoneError";
  }
}

interface SettlementDbRow {
  id: string;
  bill_id: string;
  participant_id: string;
  cents: number;
  recorded_at: string;
  recorded_by: string;
}

function toSettlement(r: SettlementDbRow): Settlement {
  return {
    id: r.id,
    billId: r.bill_id,
    participant: r.participant_id,
    cents: r.cents,
    recordedAt: r.recorded_at,
    recordedBy: r.recorded_by,
  };
}

const REMAINING = `(${groupOwedSql("?1", "?3")} - ${groupPaidSql("?1", "?3")})`;

// A debtor's standing as Outstanding reports it: asked for, less what their
// guests paid directly, against what they paid themselves.
function standingSql(bill: string, who: string): string {
  return `${groupOwedSql(bill, who)} - ${groupPaidSql(bill, who)} + ${ownPaidSql(bill, who)} AS owed, ${ownPaidSql(bill, who)} AS settled`;
}

// Every rule is in the INSERT's own WHERE, so a reopen, an undo or a second
// tap landing between the person's look at the card and this write cannot
// let through a payment the rules refuse. `remainingCents` is the amount a
// paid-it-all button was drawn with; it must still be what is left.
//
// `id` makes the write idempotent: a caller that has a stable id for the
// request (a Discord interaction id) passes it, and the same request arriving
// again finds its own row instead of recording a second payment. Resolves
// false in that case, true when this call wrote the row.
export async function recordSettlement(
  db: D1Database,
  billId: string,
  participantId: ParticipantId,
  cents: Cents,
  recordedBy: ParticipantId,
  options: { remainingCents?: Cents; id?: string } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new SettlementRefusedError("not-positive");
  const id = options.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by)
         SELECT ?2, ?1, ?3, ?4, ?5, ?6
         FROM shares s JOIN bills b ON b.id = s.bill_id
         JOIN participants p ON p.bill_id = s.bill_id AND p.id = s.participant_id AND p.kind = 'member'
         WHERE s.bill_id = ?1 AND s.participant_id = ?3
           AND b.status = 'confirmed'
           AND b.payer_id <> ?3
           AND (?6 = ?3 OR ?6 = b.payer_id)
           AND ?4 <= ${REMAINING}
           AND (?7 IS NULL OR ?7 = ${REMAINING})
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
      )
      .bind(billId, id, participantId, cents, now, recordedBy, options.remainingCents ?? null),
    settledAtStatement(db, billId, participantId, now),
  ]);
  if (inserted!.results.length === 1) return true;
  // Asked before why the write refused: a replay of a payment that cleared
  // the balance would otherwise be told it is already paid up, when it is
  // that very payment.
  if (options.id !== undefined && (await isSamePayment(db, options.id, billId, participantId, cents, recordedBy))) return false;
  throw await whyRefused(db, billId, participantId, cents, recordedBy, options.remainingCents);
}

async function isSamePayment(
  db: D1Database,
  id: string,
  billId: string,
  participantId: ParticipantId,
  cents: Cents,
  recordedBy: ParticipantId,
): Promise<boolean> {
  const row = await getSettlement(db, id);
  return row?.billId === billId && row.participant === participantId && row.cents === cents && row.recordedBy === recordedBy;
}

// The write said no without saying why; this reads the bill as it is now to
// give the person today's reason.
async function whyRefused(
  db: D1Database,
  billId: string,
  participantId: ParticipantId,
  cents: Cents,
  recordedBy: ParticipantId,
  pinned: Cents | undefined,
): Promise<SettlementRefusedError> {
  const row = await db
    .prepare(
      `SELECT b.status, b.payer_id, s.owed_cents IS NOT NULL AND p.kind = 'member' AS has_share, ${REMAINING} AS remaining
       FROM bills b
       LEFT JOIN shares s ON s.bill_id = b.id AND s.participant_id = ?3
       LEFT JOIN participants p ON p.bill_id = b.id AND p.id = ?3
       WHERE b.id = ?1`,
    )
    .bind(billId, null, participantId)
    .first<{ status: string; payer_id: string; has_share: number; remaining: number | null }>();
  if (row?.status !== "confirmed") return new SettlementRefusedError("not-confirmed");
  if (recordedBy !== participantId && recordedBy !== row.payer_id) return new SettlementRefusedError("not-allowed");
  if (participantId === row.payer_id) return new SettlementRefusedError("payer");
  if (!row.has_share || row.remaining === null) return new SettlementRefusedError("no-share");
  const remaining = row.remaining;
  if (remaining <= 0) return new SettlementRefusedError("clear", remaining);
  if (pinned !== undefined && pinned !== remaining) return new SettlementRefusedError("stale", remaining);
  if (cents > remaining) return new SettlementRefusedError("over", remaining);
  // Everything checks out now, so something moved between the write and this
  // read; the amount the person saw is what changed.
  return new SettlementRefusedError("stale", remaining);
}

export async function getSettlement(db: D1Database, settlementId: string): Promise<Settlement | null> {
  const row = await db
    .prepare("SELECT id, bill_id, participant_id, cents, recorded_at, recorded_by FROM settlements WHERE id = ?")
    .bind(settlementId)
    .first<SettlementDbRow>();
  return row ? toSettlement(row) : null;
}

// Newest first: the payment someone wants to take back is usually the last one.
export async function listSettlements(db: D1Database, billId: string): Promise<Settlement[]> {
  const { results } = await db
    .prepare(
      `SELECT id, bill_id, participant_id, cents, recorded_at, recorded_by FROM settlements
       WHERE bill_id = ? ORDER BY recorded_at DESC, rowid DESC`,
    )
    .bind(billId)
    .all<SettlementDbRow>();
  return results.map(toSettlement);
}

// Paid is yes or no, so taking it back removes everything the person paid on
// the bill, a part payment recorded before that rule included. Only on a
// confirmed bill, like recording: a reopened bill's payments are what its
// re-confirm reports against, so they hold still until then. Resolves to the
// cents taken back.
export async function undoPaid(db: D1Database, billId: string, participantId: ParticipantId): Promise<Cents> {
  const [removed] = await db.batch<{ cents: number }>([
    db
      .prepare(
        `DELETE FROM settlements
         WHERE bill_id = ?1 AND participant_id = ?2 AND EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND status = 'confirmed')
         RETURNING cents`,
      )
      .bind(billId, participantId),
    settledAtStatement(db, billId, participantId, new Date().toISOString()),
  ]);
  if (removed!.results.length > 0) return removed!.results.reduce((sum, r) => sum + r.cents, 0);
  const left = await db.prepare("SELECT 1 FROM settlements WHERE bill_id = ? AND participant_id = ?").bind(billId, participantId).first();
  if (!left) throw new SettlementGoneError(`${billId}/${participantId}`);
  throw new BillNotConfirmedError(billId);
}

// Everyone on the bill who answers for a share, cleared or not, but the payer:
// every other member, and any guest the payer added. A guest another member
// added is never a row; that member answers for them.
export async function outstanding(db: D1Database, billId: string): Promise<Outstanding[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS participant_id, ${standingSql("?1", "p.id")}
       FROM participants p JOIN bills b ON b.id = p.bill_id
       WHERE p.bill_id = ?1 AND p.id <> b.payer_id AND ${debtorSql("p", "b.payer_id")} = p.id
         AND EXISTS (SELECT 1 FROM shares s WHERE s.bill_id = ?1 AND s.participant_id = p.id)
       ORDER BY p.id`,
    )
    .bind(billId)
    .all<{ participant_id: string; owed: number; settled: number }>();
  return results.map((r) => ({ participant: r.participant_id, owedCents: r.owed, settledCents: r.settled }));
}

// Who still owes `payerId`, one row per person across every confirmed bill
// they paid for (or one server's, with `guildId`). A person is their Discord
// user id on every bill, so the same friend rolls up across servers; a guest
// is a label on one bill, so a guest another member added rolls into that
// member's row, and one the payer added is a row for that bill alone. Only
// bills with money still owed count: a share overpaid after a correction is
// money the payer owes back, which a "who owes me" total must not quietly net
// against someone's other debts.
export async function ledger(db: D1Database, payerId: ParticipantId, guildId?: string): Promise<LedgerRow[]> {
  const { results } = await db
    .prepare(
      `WITH per_bill AS (
         SELECT p.id AS participant, p.display_name, p.kind, b.place, b.created_at, b.rowid AS seq,
           ${standingSql("b.id", "p.id")}
         FROM bills b
         JOIN participants p ON p.bill_id = b.id
         WHERE b.payer_id = ?1 AND b.status = 'confirmed' AND p.id <> ?1 AND ${debtorSql("p", "b.payer_id")} = p.id
           AND (?2 IS NULL OR b.guild_id = ?2)
           AND EXISTS (SELECT 1 FROM shares s WHERE s.bill_id = b.id AND s.participant_id = p.id)
       ),
       owing AS (SELECT * FROM per_bill WHERE owed > settled),
       latest AS (
         SELECT participant, display_name, kind, place,
           ROW_NUMBER() OVER (PARTITION BY participant ORDER BY created_at DESC, seq DESC) AS n
         FROM owing
       )
       SELECT o.participant, l.display_name, l.kind, l.place,
         SUM(o.owed) AS owed, SUM(o.settled) AS settled, COUNT(*) AS bills
       FROM owing o JOIN latest l ON l.participant = o.participant AND l.n = 1
       GROUP BY o.participant
       ORDER BY SUM(o.owed) - SUM(o.settled) DESC, o.participant`,
    )
    .bind(payerId, guildId ?? null)
    .all<{ participant: string; display_name: string; kind: "member" | "guest"; place: string | null; owed: number; settled: number; bills: number }>();
  return results.map((r) => ({
    participant: r.participant,
    displayName: r.display_name,
    kind: r.kind,
    place: r.place,
    owedCents: r.owed,
    settledCents: r.settled,
    billCount: r.bills,
  }));
}

// "forgiven": the payer waived the guest's share, so there is nothing to pay.
// "covered": the group has less left than the guest's share, because the
// member who added them already paid it. "changed": the bill moved between
// the write and the read that explains it.
export type GuestPaidRefusal = "not-confirmed" | "no-guest" | "no-share" | "forgiven" | "nothing-owed" | "covered" | "changed";

export class GuestPaidRefusedError extends Error {
  constructor(readonly reason: GuestPaidRefusal) {
    super(`guest paid mark refused: ${reason}`);
    this.name = "GuestPaidRefusedError";
  }
}

const CONFIRMED_GUEST = `EXISTS (SELECT 1 FROM bills WHERE id = ?1 AND status = 'confirmed')
  AND EXISTS (SELECT 1 FROM participants WHERE bill_id = ?1 AND id = ?2 AND kind = 'guest')`;
const GUEST_PAID = "EXISTS (SELECT 1 FROM settlements WHERE bill_id = ?1 AND participant_id = ?2)";

// The payer's mark: the guest paid the payer directly. It is a payment like
// any other, recorded against the guest for their whole frozen share, so it
// comes off what the member who added them owes and the caller tells the
// channel. Unmarking takes the guest's payment back. `cents` is the payment made or taken back; null means
// the mark already said that.
export async function setGuestPaidToPayer(
  db: D1Database,
  billId: string,
  guestId: ParticipantId,
  paid: boolean,
): Promise<{ revision: number; cents: Cents } | null> {
  const debtor = debtorOfSql("?1", "?2");
  const share = "(SELECT owed_cents FROM shares WHERE bill_id = ?1 AND participant_id = ?2 AND pardoned = 0)";
  const allowed = paid
    ? `${CONFIRMED_GUEST} AND NOT ${GUEST_PAID} AND ${share} > 0
       AND ${share} <= ${groupOwedSql("?1", debtor)} - ${groupPaidSql("?1", debtor)}`
    : `${CONFIRMED_GUEST} AND ${GUEST_PAID}`;
  const now = new Date().toISOString();
  // The bump goes first so it judges the bill as the write does, before it.
  const write = paid
    ? db
        .prepare(
          `INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by)
           SELECT ?3, ?1, ?2, s.owed_cents, ?4, b.payer_id FROM shares s JOIN bills b ON b.id = s.bill_id
           WHERE s.bill_id = ?1 AND s.participant_id = ?2 AND ${allowed}
           RETURNING cents`,
        )
        .bind(billId, guestId, crypto.randomUUID(), now)
    : db.prepare(`DELETE FROM settlements WHERE bill_id = ?1 AND participant_id = ?2 AND ${allowed} RETURNING cents`).bind(billId, guestId);
  const [bump, written] = await db.batch<{ revision: number; cents: number }>([
    db.prepare(`UPDATE bills SET revision = revision + 1 WHERE id = ?1 AND ${allowed} RETURNING revision`).bind(billId, guestId),
    write,
    settledAtStatement(db, billId, guestId, now),
  ]);
  const row = bump!.results[0];
  if (row) return { revision: row.revision, cents: written!.results.reduce((sum, r) => sum + r.cents, 0) };

  const at = await guestStanding(db, billId, guestId);
  if (at.paid === paid) return null;
  if (!paid) throw new GuestPaidRefusedError("changed");
  if (at.pardoned) throw new GuestPaidRefusedError("forgiven");
  if (at.owed <= 0) throw new GuestPaidRefusedError("nothing-owed");
  if (at.owed > at.remaining) throw new GuestPaidRefusedError("covered");
  throw new GuestPaidRefusedError("changed");
}

// The adder's mark: the guest paid the member who added them. That member
// still owes the payer the guest's share, so no money moves; it only lets the
// member keep track. A guest the payer added has only the payer's mark.
export async function setGuestPaidToHost(
  db: D1Database,
  billId: string,
  guestId: ParticipantId,
  paid: boolean,
): Promise<number | null> {
  const allowed = `${CONFIRMED_GUEST}
    AND EXISTS (SELECT 1 FROM participants q JOIN bills b ON b.id = q.bill_id
                WHERE q.bill_id = ?1 AND q.id = ?2 AND q.added_by <> b.payer_id)
    AND EXISTS (SELECT 1 FROM shares WHERE bill_id = ?1 AND participant_id = ?2 AND (paid_to_host_at IS NOT NULL) <> ?3)`;
  const [bump] = await db.batch<{ revision: number }>([
    db.prepare(`UPDATE bills SET revision = revision + 1 WHERE id = ?1 AND ${allowed} RETURNING revision`).bind(billId, guestId, paid ? 1 : 0),
    db
      .prepare(
        `UPDATE shares SET paid_to_host_at = CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END
         WHERE bill_id = ?1 AND participant_id = ?2 AND ${allowed}`,
      )
      .bind(billId, guestId, paid ? 1 : 0, new Date().toISOString()),
  ]);
  const row = bump!.results[0];
  if (row) return row.revision;

  const at = await guestStanding(db, billId, guestId);
  if (at.paidToHost === paid) return null;
  throw new GuestPaidRefusedError("changed");
}

// Why a guest mark changed nothing, read from the bill as it is now. Throws
// for the reasons both marks share.
async function guestStanding(
  db: D1Database,
  billId: string,
  guestId: ParticipantId,
): Promise<{ paid: boolean; paidToHost: boolean; pardoned: boolean; owed: Cents; remaining: Cents }> {
  const debtor = debtorOfSql("?1", "?2");
  const row = await db
    .prepare(
      `SELECT b.status, p.kind, s.owed_cents, s.pardoned, s.paid_to_host_at IS NOT NULL AS paid_to_host, ${GUEST_PAID} AS paid,
         ${groupOwedSql("?1", debtor)} - ${groupPaidSql("?1", debtor)} AS remaining
       FROM bills b
       LEFT JOIN participants p ON p.bill_id = b.id AND p.id = ?2
       LEFT JOIN shares s ON s.bill_id = b.id AND s.participant_id = ?2
       WHERE b.id = ?1`,
    )
    .bind(billId, guestId)
    .first<{
      status: string;
      kind: string | null;
      owed_cents: number | null;
      pardoned: number | null;
      paid_to_host: number;
      paid: number;
      remaining: number;
    }>();
  if (row?.status !== "confirmed") throw new GuestPaidRefusedError("not-confirmed");
  if (row.kind !== "guest") throw new GuestPaidRefusedError("no-guest");
  if (row.owed_cents === null) throw new GuestPaidRefusedError("no-share");
  return {
    paid: row.paid === 1,
    paidToHost: row.paid_to_host === 1,
    pardoned: row.pardoned === 1,
    owed: row.owed_cents,
    remaining: row.remaining,
  };
}
