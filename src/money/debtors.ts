import type { Cents, ParticipantId, Share } from "./types";

export interface Diner {
  id: ParticipantId;
  kind: "member" | "guest";
  addedBy: ParticipantId | null;
}

// A guest cannot tap anything, so the member who added them answers for their
// share. A guest the payer added owes the payer directly: there is nobody else
// to collect it, and the payer can mark it paid when it arrives. Derived
// rather than stored, so it can never disagree with the roster or the payer.
export function debtorOf(diner: Diner, payer: ParticipantId): ParticipantId {
  return diner.kind === "guest" && diner.addedBy && diner.addedBy !== payer ? diner.addedBy : diner.id;
}

export function owedAfterPardon(share: Share): Cents {
  return share.pardoned ? 0 : share.owedCents;
}

export interface DebtorGroup {
  debtor: ParticipantId;
  own: Share | undefined;
  guests: Share[];
  // Every share in the group, after pardons: what the debtor is asked for.
  owedCents: Cents;
}

// One group per person who answers for any share, in roster order, own share
// first, guests in the order they were added. A group exists only when at
// least one of its shares does.
export function groupByDebtor(shares: Share[], diners: Diner[], payer: ParticipantId): DebtorGroup[] {
  const byId = new Map(shares.map((s) => [s.participant, s]));
  const groups = new Map<ParticipantId, DebtorGroup>();
  for (const diner of diners) {
    const share = byId.get(diner.id);
    const debtor = debtorOf(diner, payer);
    let group = groups.get(debtor);
    if (!group) {
      group = { debtor, own: undefined, guests: [], owedCents: 0 };
      groups.set(debtor, group);
    }
    if (!share) continue;
    if (debtor === diner.id) group.own = share;
    else group.guests.push(share);
    group.owedCents += owedAfterPardon(share);
  }
  return [...groups.values()].filter((g) => g.own !== undefined || g.guests.length > 0);
}

export function groupOf(groups: DebtorGroup[], debtor: ParticipantId): DebtorGroup | undefined {
  return groups.find((g) => g.debtor === debtor);
}

export interface DebtorPaid {
  // What the debtor paid themselves.
  ownCents: Cents;
  // What their guests paid the payer directly, which comes off what the
  // debtor is asked for rather than counting as the debtor's payment.
  directCents: Cents;
}

// Payments summed per debtor. A payment recorded against a guest is that
// guest paying the payer directly, so it lands in the group of whoever
// answers for the guest.
export function paidByDebtor(
  paid: { participant: ParticipantId; cents: Cents }[],
  diners: Diner[],
  payer: ParticipantId,
): Map<ParticipantId, DebtorPaid> {
  const byId = new Map(diners.map((d) => [d.id, d]));
  const totals = new Map<ParticipantId, DebtorPaid>();
  for (const { participant, cents } of paid) {
    const diner = byId.get(participant);
    const debtor = diner ? debtorOf(diner, payer) : participant;
    const total = totals.get(debtor) ?? { ownCents: 0, directCents: 0 };
    if (debtor === participant) total.ownCents += cents;
    else total.directCents += cents;
    totals.set(debtor, total);
  }
  return totals;
}
