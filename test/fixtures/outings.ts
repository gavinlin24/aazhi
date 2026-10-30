import { addClaim, addGuest, addParticipant, confirmBill, createBill, getBill, insertItems, setPardon } from "../../src/db/bills";

export interface Outing {
  id: string;
  guild?: string;
  channel?: string;
  // The first person listed is the payer.
  people: [id: string, name: string][];
  place?: string | null;
  billDate?: string | null;
  createdAt?: string;
  // [label, cents, who claimed it]
  items: [label: string, cents: number, claimedBy: string[]][];
  guest?: { name: string; addedBy: string; item: [label: string, cents: number] };
  pardon?: string;
  // Stop before Confirm, for a draft that must not count.
  draft?: boolean;
}

// One outing the way the app leaves it in D1: rows through the same writes the
// app uses, frozen by the real confirm, then dated, since tests need the past.
export async function seedOuting(db: D1Database, o: Outing): Promise<void> {
  const payer = o.people[0]![0];
  const guestCents = o.guest?.item[1] ?? 0;
  await createBill(db, {
    id: o.id,
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
    for (const who of claimedBy) await addClaim(db, o.id, `${o.id}-${i}`, who);
  }
  if (o.guest) {
    const [label, cents] = o.guest.item;
    const id = `${o.id}-guest-person`;
    await addGuest(db, o.id, { id, displayName: o.guest.name, addedBy: o.guest.addedBy });
    await insertItems(db, o.id, [{ id: `${o.id}-guest`, label, cents, source: "ocr" }]);
    await addClaim(db, o.id, `${o.id}-guest`, id);
  }
  if (!o.draft) {
    const bill = (await getBill(db, o.id))!;
    const result = await confirmBill(db, o.id, bill.revision, payer);
    if (!result.ok) throw new Error(`could not confirm ${o.id}: ${result.reason}`);
    if (o.pardon) await setPardon(db, o.id, o.pardon, true);
  }
  // The month guard reads a print date against the day the bill was made, so a
  // dated outing has to be made on that date, whatever today is.
  const createdAt = o.createdAt ?? (o.billDate ? `${o.billDate}T20:00:00.000Z` : null);
  if (createdAt) await db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").bind(createdAt, o.id).run();
}
