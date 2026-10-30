import { getSettled, getShares, type BillRow, type BillSnapshot, type Participant, type Settled } from "../db/bills";
import { getPaymentHandles, type PaymentHandle } from "../db/handles";
import { listSettlements, type Settlement } from "../db/settlements";
import { billName, clip, MAX_NOTE } from "../discord/notices";
import { reconciles } from "../extract/claude";
import { groupByDebtor, paidByDebtor } from "../money/debtors";
import { splitBill } from "../money/split";
import type { Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";
import { METHOD_NAMES, payLink, type PayMethod } from "./paylink";

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
  // Debtors with a payment against their group, their own or a guest's paid
  // to the payer directly. A pardon would rewrite what those payments were
  // measured against, so their group can't be forgiven.
  paid: ParticipantId[];
  // What the payer is owed by everyone else, a guest the payer added included.
  payerCollectsCents: Cents;
  taxCents: Cents;
  tipCents: Cents;
  printedTotalCents: Cents | null;
  reconciles: { ok: boolean; discrepancyCents: Cents | null };
  items: LineItem[];
  participants: StateParticipant[];
  result: SplitResult;
  // Display only, from here down.
  // One entry per debtor: the one amount the page shows as theirs (their own
  // share and their guests', after pardons, less what any guest paid the
  // payer directly), and what they have paid towards it themselves. Worked
  // out here so the page and its script never redo the debtor rule.
  owing: Record<ParticipantId, { owedCents: Cents; paidCents: Cents }>;
  // The viewer's ways to pay what they have left. Empty unless the bill is
  // confirmed and they owe.
  pay: PayOption[];
  // Every payment recorded on the bill, newest first, so the payer can take
  // one back or see what deleting the bill would throw away. Only the payer's
  // view carries them: they were paid to the payer.
  payments: Payment[];
}

export type Payment = Pick<Settlement, "id" | "participant" | "cents" | "recordedAt">;

// A guest also carries the two paid marks. paidToPayer: the guest paid the
// payer directly, so their share is off the adder's total. paidToHost: the
// guest paid the member who added them, which changes nothing the member owes.
export type StateParticipant = Pick<Participant, "id" | "kind" | "displayName" | "addedBy"> & {
  paidToPayer?: boolean;
  paidToHost?: boolean;
};

export interface GuestsPaid {
  paidToPayer?: ParticipantId[];
  paidToHost?: ParticipantId[];
}

export type PayOption = { method: PayMethod; name: string } & ({ url: string } | { address: string });

// What the page needs beyond the server's state. For a confirmed bill: the
// payments, for what is left, and the payer's handles, for links. For the
// payer: the payments one by one.
export interface PayExtras {
  settled?: Settled[];
  handles?: PaymentHandle[];
  payments?: Settlement[];
}

// Everything renderPage takes besides the bill, in one bag.
export type StateExtras = { hasPayments?: boolean; paid?: ParticipantId[] } & GuestsPaid & PayExtras;

// Someone holding a link to a bill they are not on (they opened it while it
// was confirmed, and it was reopened since) gets nothing to tap: claiming
// needs a roster row, and only Open the split adds one.
export function editableFor(bill: BillRow, participants: Pick<Participant, "id">[], viewer: ParticipantId): Editable {
  if (bill.status !== "draft") return "none";
  if (viewer === bill.payerId) return "all";
  return participants.some((p) => p.id === viewer) ? "self" : "none";
}

// The same sums the payment check uses: a guest's payment
// to the payer comes off what their debtor is asked for instead of counting
// as the debtor's own payment.
function owingOf(shares: Share[], participants: Participant[], payer: ParticipantId, settled: Settled[]): BillState["owing"] {
  const paid = paidByDebtor(settled, participants, payer);
  const owing: BillState["owing"] = {};
  for (const group of groupByDebtor(shares, participants, payer)) {
    const { ownCents = 0, directCents = 0 } = paid.get(group.debtor) ?? {};
    owing[group.debtor] = { owedCents: group.owedCents - directCents, paidCents: ownCents };
  }
  return owing;
}

// What is left, not the frozen amount: a link for the full share after a
// partial payment would ask the person to pay twice.
function payOptions(bill: BillRow, handles: PaymentHandle[], leftCents: Cents): PayOption[] {
  if (leftCents <= 0) return [];
  const note = clip(billName(bill), MAX_NOTE);
  return handles.map(({ method, handle }) => ({ method, name: METHOD_NAMES[method], ...payLink(method, handle, leftCents, note) }));
}

export function billState(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  viewer: ParticipantId,
  hasPayments: boolean,
  paid: ParticipantId[] = [],
  guestsPaid: GuestsPaid = {},
  payExtras: PayExtras = {},
): BillState {
  const toPayer = new Set(guestsPaid.paidToPayer);
  const toHost = new Set(guestsPaid.paidToHost);
  const owing = owingOf(result.shares, participants, bill.payerId, payExtras.settled ?? []);
  const mine = owing[viewer];
  const pay =
    bill.status === "confirmed" && viewer !== bill.payerId && mine
      ? payOptions(bill, payExtras.handles ?? [], mine.owedCents - mine.paidCents)
      : [];
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
    payerCollectsCents: result.payerCollectsCents,
    taxCents: bill.taxCents,
    tipCents: bill.tipCents,
    printedTotalCents: bill.printedTotalCents,
    reconciles: reconciles({ items, taxCents: bill.taxCents, printedTotalCents: bill.printedTotalCents }),
    items,
    participants: participants.map((p) => {
      const base = { id: p.id, kind: p.kind, displayName: p.displayName, addedBy: p.addedBy };
      return p.kind === "guest" ? { ...base, paidToPayer: toPayer.has(p.id), paidToHost: toHost.has(p.id) } : base;
    }),
    result,
    owing,
    pay,
    payments:
      viewer === bill.payerId
        ? (payExtras.payments ?? []).map(({ id, participant, cents, recordedAt }) => ({ id, participant, cents, recordedAt }))
        : [],
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

// Payments and handles are reads of their own for the same reason. Totals and
// handles only matter once the bill is confirmed: nobody pays a draft. The
// payer's list of payments matters on a reopened draft too, since deleting
// it would throw them away.
async function payExtrasOf(db: D1Database, snapshot: BillSnapshot, viewer: ParticipantId): Promise<PayExtras> {
  const { bill, hasPayments } = snapshot;
  const [payments, confirmed] = await Promise.all([
    viewer === bill.payerId && hasPayments ? listSettlements(db, bill.id) : undefined,
    bill.status === "confirmed" ? Promise.all([getSettled(db, bill.id), getPaymentHandles(db, bill.payerId)]) : undefined,
  ]);
  return { ...(confirmed ? { settled: confirmed[0], handles: confirmed[1] } : {}), ...(payments ? { payments } : {}) };
}

// Everything the page is rendered from besides the bill's own rows.
export async function pageData(
  db: D1Database,
  snapshot: BillSnapshot,
  viewer: ParticipantId,
): Promise<{ result: SplitResult; extras: StateExtras }> {
  const { hasPayments, paid, paidToPayer, paidToHost } = snapshot;
  const [result, pay] = await Promise.all([pageResult(db, snapshot), payExtrasOf(db, snapshot, viewer)]);
  return { result, extras: { hasPayments, paid, paidToPayer, paidToHost, ...pay } };
}

export async function stateOf(db: D1Database, snapshot: BillSnapshot, viewer: ParticipantId): Promise<BillState> {
  const { bill, input, participants, hasPayments, paid, paidToPayer, paidToHost } = snapshot;
  const [result, pay] = await Promise.all([pageResult(db, snapshot), payExtrasOf(db, snapshot, viewer)]);
  return billState(bill, result, input.items, participants, viewer, hasPayments, paid, { paidToPayer, paidToHost }, pay);
}
