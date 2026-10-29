import { addClaim, addParticipant, createBill, getBill, insertItems, type BillRow, type NewBill } from "../../src/db/bills";
import { SAIGON } from "./saigon";

export const SAIGON_NAMES: Record<string, string> = {
  dani: "Dani",
  gavin: "Gavin",
  jess: "Jess",
  lena: "Lena",
  marcus: "Marcus",
  omar: "Omar",
  priya: "Priya",
  theo: "Theo",
};

export interface SeedOptions {
  bill?: Partial<NewBill>;
  // Who is on the roster; defaults to all eight diners.
  participants?: string[];
  // Items left with nobody on them.
  unclaimed?: string[];
}

// The Saigon Kitchen bill as D1 rows. Item ids are prefixed with the bill id
// because item ids are global, so two seeded bills never collide.
export async function seedSaigon(db: D1Database, billId: string, options: SeedOptions = {}): Promise<BillRow> {
  const roster = options.participants ?? SAIGON.participants;
  await createBill(db, {
    id: billId,
    guildId: "guild-1",
    channelId: "chan-1",
    messageId: "msg-1",
    payerId: SAIGON.payer,
    place: "Saigon Kitchen",
    billDate: "2026-10-28",
    taxCents: SAIGON.taxCents,
    tipCents: SAIGON.tipCents,
    printedTotalCents: 27382,
    status: "draft",
    ...options.bill,
  });
  await insertItems(
    db,
    billId,
    SAIGON.items.map((i) => ({ id: `${billId}-${i.id}`, label: i.label, cents: i.cents, source: "ocr" as const, confidence: 0.95 })),
  );
  for (const id of roster) {
    await addParticipant(db, { billId, id, kind: "member", displayName: SAIGON_NAMES[id] ?? id, addedBy: null });
  }
  for (const item of SAIGON.items) {
    if (options.unclaimed?.includes(item.id)) continue;
    for (const who of item.claimedBy.filter((p) => roster.includes(p))) {
      await addClaim(db, billId, `${billId}-${item.id}`, who);
    }
  }
  return (await getBill(db, billId))!;
}
