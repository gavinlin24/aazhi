import type { Cents, ParticipantId, Share } from "./types";

export interface Diner {
  id: ParticipantId;
  kind: "member" | "guest";
  addedBy: ParticipantId | null;
}

// A guest cannot tap anything, so the member who brought them answers for
// their share. Derived rather than stored, so it can never disagree with the
// roster.
export function debtorOf(diner: Diner): ParticipantId {
  return diner.kind === "guest" && diner.addedBy ? diner.addedBy : diner.id;
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

// One group per member who answers for any share, in roster order, own share
// first, guests in the order they were added. A group exists only when at
// least one of its shares does.
export function groupByDebtor(shares: Share[], diners: Diner[]): DebtorGroup[] {
  const byId = new Map(shares.map((s) => [s.participant, s]));
  const groups = new Map<ParticipantId, DebtorGroup>();
  for (const diner of diners) {
    const share = byId.get(diner.id);
    const debtor = debtorOf(diner);
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

// The engine counts a guest like any diner; a guest who came with the payer
// has nobody else to collect from, so the payer absorbs that share too.
export function payerCollects(payerCollectsCents: Cents, shares: Share[], diners: Diner[], payer: ParticipantId): Cents {
  const absorbed = groupOf(groupByDebtor(shares, diners), payer)?.guests.reduce((sum, s) => sum + owedAfterPardon(s), 0) ?? 0;
  return payerCollectsCents - absorbed;
}
