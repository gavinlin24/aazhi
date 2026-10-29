import type { BillRow, BillSnapshot, Participant } from "../db/bills";
import { reconciles } from "../extract/claude";
import { splitBill } from "../money/split";
import type { Cents, LineItem, ParticipantId, SplitResult } from "../money/types";

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
    taxCents: bill.taxCents,
    tipCents: bill.tipCents,
    printedTotalCents: bill.printedTotalCents,
    reconciles: reconciles({ items, taxCents: bill.taxCents, printedTotalCents: bill.printedTotalCents }),
    items,
    participants: participants.map((p) => ({ id: p.id, kind: p.kind, displayName: p.displayName, addedBy: p.addedBy })),
    result,
  };
}

export function stateOf(snapshot: BillSnapshot, viewer: ParticipantId): BillState {
  const { bill, input, participants, hasPayments } = snapshot;
  return billState(bill, splitBill(input), input.items, participants, viewer, hasPayments);
}
