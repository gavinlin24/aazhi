import { getShares, type BillRow, type BillSnapshot, type Participant } from "../db/bills";
import { reconciles } from "../extract/claude";
import { payerCollects } from "../money/debtors";
import { splitBill } from "../money/split";
import type { Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";

export type Editable = "all" | "self" | "none";

// What the page renders from: embedded in the HTML on first load, then
// returned by every write and every poll, so the script has one render path.
export interface BillState {
  billId: string;
  revision: number;
  status: BillRow["status"];
  payerId: ParticipantId;
  viewer: ParticipantId;
  viewerIsPayer: boolean;
  editable: Editable;
  // Once anyone has paid, the bill can't be handed to another payer: every
  // recorded payment went to this one.
  hasPayments: boolean;
  // Members with a payment recorded. A pardon would rewrite what their
  // payments were measured against, so their group can't be forgiven.
  paid: ParticipantId[];
  // What the payer is owed by everyone else: the engine's figure less the
  // shares of guests who came with the payer, which nobody else answers for.
  payerCollectsCents: Cents;
  taxCents: Cents;
  tipCents: Cents;
  printedTotalCents: Cents | null;
  reconciles: { ok: boolean; discrepancyCents: Cents | null };
  items: LineItem[];
  participants: Pick<Participant, "id" | "kind" | "displayName" | "addedBy">[];
  result: SplitResult;
}

// Someone holding a link to a bill they are not on (they opened it while it
// was confirmed, and it was reopened since) gets nothing to tap: claiming
// needs a roster row, and only Open the split adds one.
export function editableFor(bill: BillRow, participants: Pick<Participant, "id">[], viewer: ParticipantId): Editable {
  if (bill.status !== "draft") return "none";
  if (viewer === bill.payerId) return "all";
  return participants.some((p) => p.id === viewer) ? "self" : "none";
}

export function billState(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  viewer: ParticipantId,
  hasPayments: boolean,
  paid: ParticipantId[] = [],
): BillState {
  return {
    billId: bill.id,
    revision: bill.revision,
    status: bill.status,
    payerId: bill.payerId,
    viewer,
    viewerIsPayer: viewer === bill.payerId,
    editable: editableFor(bill, participants, viewer),
    hasPayments,
    paid,
    payerCollectsCents: payerCollects(result.payerCollectsCents, result.shares, participants, bill.payerId),
    taxCents: bill.taxCents,
    tipCents: bill.tipCents,
    printedTotalCents: bill.printedTotalCents,
    reconciles: reconciles({ items, taxCents: bill.taxCents, printedTotalCents: bill.printedTotalCents }),
    items,
    participants: participants.map((p) => ({ id: p.id, kind: p.kind, displayName: p.displayName, addedBy: p.addedBy })),
    result,
  };
}

// Once confirmed, the shares are the rows frozen at confirm, the amounts
// people were told and are paying against, exactly as the owe card shows
// them; recomputing from the lines would let a change underneath the bill
// show someone a number nobody agreed to. The payer's figure follows from
// the same rows. The bill-level totals still come from the lines, as they do
// on the owe card.
function frozenResult(split: SplitResult, frozen: Share[], payer: ParticipantId): SplitResult {
  const payerCollectsCents = frozen.reduce((total, s) => (s.participant === payer || s.pardoned ? total : total + s.owedCents), 0);
  return { ...split, shares: frozen, payerCollectsCents };
}

// The share rows are a read of their own rather than part of the snapshot,
// which stays a fixed handful of statements for the draft path that polls it
// most. The rows survive a reopen, so they count only for a confirmed bill.
export async function pageResult(db: D1Database, snapshot: BillSnapshot): Promise<SplitResult> {
  const split = splitBill(snapshot.input);
  if (snapshot.bill.status !== "confirmed") return split;
  return frozenResult(split, await getShares(db, snapshot.bill.id), snapshot.bill.payerId);
}

export async function stateOf(db: D1Database, snapshot: BillSnapshot, viewer: ParticipantId): Promise<BillState> {
  const { bill, input, participants, hasPayments, paid } = snapshot;
  return billState(bill, await pageResult(db, snapshot), input.items, participants, viewer, hasPayments, paid);
}
