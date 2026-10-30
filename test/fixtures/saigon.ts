import type { BillInput, LineItem, ParticipantId } from "../../src/money/types";
import { seededRandom, shuffle } from "./random";

// The Saigon Kitchen bill from the spec. Subtotal 25150, tax 2232, tip 5030,
// distributable 32412. Later tasks assert against these exact cents, so a
// change here ripples through every bill test.
export const SAIGON: BillInput = {
  items: [
    { id: "rolls", label: "Spring rolls", cents: 1500, claimedBy: ["marcus", "dani", "omar"] },
    { id: "pho", label: "Pho dac biet", cents: 2100, claimedBy: ["theo"] },
    { id: "banhxeo", label: "Banh xeo", cents: 1100, claimedBy: ["theo", "lena"] },
    { id: "tea", label: "Thai iced tea x3", cents: 1500, claimedBy: ["marcus", "jess", "priya"] },
    { id: "water", label: "Sparkling water", cents: 600, claimedBy: ["gavin", "lena"] },
    { id: "bun", label: "Bun bo Hue", cents: 2450, claimedBy: ["marcus"] },
    { id: "beef", label: "Shaking beef", cents: 3450, claimedBy: ["gavin"] },
    { id: "vermicelli", label: "Vermicelli bowl", cents: 1550, claimedBy: ["lena"] },
    { id: "claypot", label: "Clay pot fish", cents: 3450, claimedBy: ["priya"] },
    { id: "curry", label: "Lemongrass curry", cents: 2900, claimedBy: ["jess"] },
    { id: "noodles", label: "Garlic noodles", cents: 3200, claimedBy: ["dani"] },
    { id: "comtam", label: "Com tam", cents: 950, claimedBy: ["omar"] },
    { id: "coconut", label: "Fresh coconut", cents: 400, claimedBy: ["omar"] },
  ],
  discountCents: 0,
  taxCents: 2232,
  tipCents: 5030,
  payer: "gavin",
  participants: ["dani", "gavin", "jess", "lena", "marcus", "omar", "priya", "theo"],
  pardoned: [],
};

export function oneItem(cents: number, claimedBy: ParticipantId[]): BillInput {
  return {
    items: [{ id: "item", label: "Item", cents, claimedBy }],
    discountCents: 0,
    taxCents: 0,
    tipCents: 0,
    payer: claimedBy[0],
    participants: [...claimedBy],
    pardoned: [],
  };
}

// Reorders every claim list and the item list: the click order and receipt
// order a bill happens to carry, neither of which may move a cent.
export function shuffleClaims(bill: BillInput, random: () => number = seededRandom(1)): BillInput {
  const items = bill.items.map((item) => ({ ...item, claimedBy: shuffle(item.claimedBy, random) }));
  return { ...bill, items: shuffle(items, random) };
}

export function withUnclaimed(bill: BillInput, itemIds: string[] | "all"): BillInput {
  return {
    ...bill,
    items: bill.items.map((item) =>
      itemIds === "all" || itemIds.includes(item.id) ? { ...item, claimedBy: [] } : item,
    ),
  };
}

export function withItem(bill: BillInput, item: LineItem): BillInput {
  return { ...bill, items: [...bill.items, item] };
}
