import { addGuest, addParticipant, confirmBill, createBill, getBill, insertItems, setClaim, setPardon } from "../../src/db/bills";

export interface Outing {
  id: string;
  guild?: string;
  channel?: string;
  // The first person listed is the payer.
  people: [id: string, name: string][];
  // Someone else with a $1 line of their own, because no stat counts a bill
  // with nobody else on it.
  alongside?: [id: string, name: string];
  place?: string | null;
  billDate?: string | null;
  createdAt?: string;
  // [label, cents, who claimed it]
  items: [label: string, cents: number, claimedBy: string[]][];
  guest?: { name: string; addedBy: string; item: [label: string, cents: number] };
  pardon?: string;
  // Stop before Confirm, for a draft that must not count.
  draft?: boolean;
  // A bill from before Confirm wanted another member with a share. Those stay
  // confirmed in D1, so the stats still have to leave them out.
  older?: boolean;
  receiptKey?: string;
}

// One outing the way the app leaves it in D1: rows through the same writes the
// app uses, frozen by the real confirm, then dated, since tests need the past.
export async function seedOuting(db: D1Database, outing: Outing): Promise<void> {
  const { alongside } = outing;
  const o: Outing = alongside
    ? { ...outing, people: [...outing.people, alongside], items: [...outing.items, ["Tea", 100, [alongside[0]]]] }
    : outing;
  const payer = o.people[0]![0];
  const guestCents = o.guest?.item[1] ?? 0;
  await createBill(db, {
    id: o.id,
    receiptKey: o.receiptKey,
    guildId: o.guild ?? "guild-1",
    channelId: o.channel ?? "chan-1",
    messageId: null,
    payerId: payer,
    place: o.place === undefined ? "Saigon Kitchen" : o.place,
    billDate: o.billDate ?? null,
    discountCents: 0,
    taxCents: 0,
    tipCents: 0,
    printedTotalCents: o.items.reduce((sum, [, cents]) => sum + cents, guestCents),
    status: "draft",
  });
  const items = o.items.map(([label, cents], i) => ({ id: `${o.id}-${i}`, label, cents, source: "ocr" as const }));
  await insertItems(db, o.id, items);
  for (const [id, displayName] of o.people) {
    await addParticipant(db, { billId: o.id, id, kind: "member", displayName, addedBy: null });
  }
  for (const [i, [, , claimedBy]] of o.items.entries()) {
    for (const who of claimedBy) await setClaim(db, o.id, `${o.id}-${i}`, who, true);
  }
  if (o.guest) {
    const [label, cents] = o.guest.item;
    const id = `${o.id}-guest-person`;
    await addGuest(db, o.id, { id, displayName: o.guest.name, addedBy: o.guest.addedBy });
    await insertItems(db, o.id, [{ id: `${o.id}-guest`, label, cents, source: "ocr" }]);
    await setClaim(db, o.id, `${o.id}-guest`, id, true);
  }
  if (!o.draft) {
    // Confirm no longer makes these, so someone else stands in as payer for
    // the freeze, which keeps the shares the real ones.
    const actor = o.older ? "older-bill-stand-in" : payer;
    if (o.older) await db.prepare("UPDATE bills SET payer_id = ? WHERE id = ?").bind(actor, o.id).run();
    const bill = (await getBill(db, o.id))!;
    const result = await confirmBill(db, o.id, bill.revision, actor);
    if (!result.ok) throw new Error(`could not confirm ${o.id}: ${result.reason}`);
    if (o.older) await db.prepare("UPDATE bills SET payer_id = ? WHERE id = ?").bind(payer, o.id).run();
    if (o.pardon) await setPardon(db, o.id, o.pardon, true);
  }
  // The month guard reads a print date against the day the bill was made, so a
  // dated outing has to be made on that date, whatever today is.
  const createdAt = o.createdAt ?? (o.billDate ? `${o.billDate}T20:00:00.000Z` : null);
  if (createdAt) await db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").bind(createdAt, o.id).run();
}
