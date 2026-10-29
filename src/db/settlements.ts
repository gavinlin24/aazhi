import type { Cents, ParticipantId } from "../money/types";
import { BillNotConfirmedError, settledAtStatement } from "./bills";

export interface Settlement {
  id: string;
  billId: string;
  participant: ParticipantId;
  cents: Cents;
  recordedAt: string;
  recordedBy: ParticipantId;
}

export interface Outstanding {
  participant: ParticipantId;
  owedCents: Cents;
  settledCents: Cents;
}

export interface LedgerRow {
  participant: ParticipantId;
  displayName: string;
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

// What member `who` is asked for on `bill` (both SQL expressions): every share
// they answer for, their own and their guests', where a pardoned share asks
// for nothing.
function owedSql(bill: string, who: string): string {
  return `(SELECT COALESCE(SUM(CASE WHEN g.pardoned = 1 THEN 0 ELSE g.owed_cents END), 0)
    FROM shares g JOIN participants q ON q.bill_id = g.bill_id AND q.id = g.participant_id
    WHERE g.bill_id = ${bill} AND COALESCE(q.added_by, q.id) = ${who})`;
}

// Every payment counts, since partial payments are ordinary.
function paidSql(bill: string, who: string): string {
  return `(SELECT COALESCE(SUM(x.cents), 0) FROM settlements x WHERE x.bill_id = ${bill} AND x.participant_id = ${who})`;
}

const REMAINING = `(${owedSql("?1", "?3")} - ${paidSql("?1", "?3")})`;

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

// Only on a confirmed bill, like recording: a reopened bill's payments are
// what its re-confirm reports against, so they hold still until then. A
// settlement's bill and person never change, so reading them first is safe.
export async function undoSettlement(db: D1Database, settlementId: string): Promise<void> {
  const settlement = await getSettlement(db, settlementId);
  if (!settlement) throw new SettlementGoneError(settlementId);
  const [removed] = await db.batch([
    db
      .prepare(
        `DELETE FROM settlements
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM bills WHERE id = ?2 AND status = 'confirmed')
         RETURNING id`,
      )
      .bind(settlementId, settlement.billId),
    settledAtStatement(db, settlement.billId, settlement.participant, new Date().toISOString()),
  ]);
  if (removed!.results.length === 1) return;
  if (!(await getSettlement(db, settlementId))) throw new SettlementGoneError(settlementId);
  throw new BillNotConfirmedError(settlement.billId);
}

// Every member on the bill but the payer, cleared or not, with what they are
// asked for after any pardon (their guests' shares included) and what they
// have paid so far. A guest is never a row: their companion answers for them,
// and a guest who came with the payer is the payer's to absorb.
export async function outstanding(db: D1Database, billId: string): Promise<Outstanding[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS participant_id, ${owedSql("?1", "p.id")} AS owed, ${paidSql("?1", "p.id")} AS settled
       FROM participants p JOIN bills b ON b.id = p.bill_id
       WHERE p.bill_id = ?1 AND p.kind = 'member' AND p.id <> b.payer_id
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
// is a label on one bill, so their share rolls into their companion's row and
// never appears on its own. Only bills with money still owed count: a share
// overpaid after a correction is money the payer owes back, which a "who owes
// me" total must not quietly net against someone's other debts.
export async function ledger(db: D1Database, payerId: ParticipantId, guildId?: string): Promise<LedgerRow[]> {
  const { results } = await db
    .prepare(
      `WITH per_bill AS (
         SELECT p.id AS participant, p.display_name, b.created_at, b.rowid AS seq,
           ${owedSql("b.id", "p.id")} AS owed,
           ${paidSql("b.id", "p.id")} AS settled
         FROM bills b
         JOIN participants p ON p.bill_id = b.id AND p.kind = 'member'
         WHERE b.payer_id = ?1 AND b.status = 'confirmed' AND p.id <> ?1
           AND (?2 IS NULL OR b.guild_id = ?2)
           AND EXISTS (SELECT 1 FROM shares s WHERE s.bill_id = b.id AND s.participant_id = p.id)
       ),
       owing AS (SELECT * FROM per_bill WHERE owed > settled)
       SELECT participant,
         (SELECT o.display_name FROM owing o WHERE o.participant = owing.participant
          ORDER BY o.created_at DESC, o.seq DESC LIMIT 1) AS display_name,
         SUM(owed) AS owed, SUM(settled) AS settled, COUNT(*) AS bills
       FROM owing GROUP BY participant
       ORDER BY SUM(owed) - SUM(settled) DESC, participant`,
    )
    .bind(payerId, guildId ?? null)
    .all<{ participant: string; display_name: string; owed: number; settled: number; bills: number }>();
  return results.map((r) => ({
    participant: r.participant,
    displayName: r.display_name,
    owedCents: r.owed,
    settledCents: r.settled,
    billCount: r.bills,
  }));
}
