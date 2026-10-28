import { describe, expect, it } from "vitest";
import { splitBill } from "../../src/money/split";
import type { BillInput, LineItem, ParticipantId } from "../../src/money/types";
import { randomInt, seededRandom, shuffle } from "../fixtures/random";
import { SAIGON, oneItem, shuffleClaims, withItem, withUnclaimed } from "../fixtures/saigon";

it("shares sum to the distributable total", () => {
  const r = splitBill(SAIGON);
  expect(r.distributableCents).toBe(32412);
  expect(r.shares.reduce((s, x) => s + x.owedCents, 0)).toBe(32412);
});

it("tax and tip ride each person's own subtotal", () => {
  const byId = Object.fromEntries(splitBill(SAIGON).shares.map(s => [s.participant, s]));
  expect(byId.marcus.subtotalCents).toBe(3450);
  expect(byId.marcus.taxCents).toBe(306);
  expect(byId.marcus.tipCents).toBe(690);
  expect(byId.marcus.owedCents).toBe(4446);
  expect(byId.gavin.owedCents).toBe(4833);
  expect(byId.priya.owedCents).toBe(5091);
  expect(byId.lena.owedCents).toBe(3093);
});

it("a displayed share's three lines always sum to its total", () => {
  for (const s of splitBill(SAIGON).shares) {
    expect(s.subtotalCents + s.taxCents + s.tipCents).toBe(s.owedCents);
  }
});

it("splits a shared item between exactly its claimants", () => {
  // 1500 across marcus, dani, omar
  const byId = Object.fromEntries(splitBill(SAIGON).shares.map(s => [s.participant, s]));
  expect(byId.theo.subtotalCents).toBe(2650); // pho 2100 + shared 550, no tea
});

it("gives leftover cents to the lowest participant ids in a stable order", () => {
  // one 1000 item across three claimants: 334 / 333 / 333 by sorted id
  const r = splitBill(oneItem(1000, ["c", "a", "b"]));
  const byId = Object.fromEntries(r.shares.map(s => [s.participant, s]));
  expect([byId.a.subtotalCents, byId.b.subtotalCents, byId.c.subtotalCents])
    .toEqual([334, 333, 333]);
});

it("breaks a largest-remainder tie by the lowest participant id", () => {
  // each owes exactly 100.5 of a 201 total, so one cent decides the tie
  const r = splitBill({
    items: [
      { id: "b-dish", label: "Dish", cents: 100, claimedBy: ["b"] },
      { id: "a-dish", label: "Dish", cents: 100, claimedBy: ["a"] },
    ],
    taxCents: 1,
    tipCents: 0,
    payer: "b",
    participants: ["b", "a"],
    pardoned: [],
  });
  expect(r.shares.map(s => [s.participant, s.owedCents])).toEqual([["a", 101], ["b", 100]]);
});

it("is invariant under claim order", () => {
  const shuffled = shuffleClaims(SAIGON);
  expect(splitBill(shuffled).shares).toEqual(splitBill(SAIGON).shares);
});

it("does not inflate claimants when lines are unclaimed", () => {
  // the spec's draft state: iced teas and sparkling water unclaimed
  const r = splitBill(withUnclaimed(SAIGON, ["tea", "water"]));
  const byId = Object.fromEntries(r.shares.map(s => [s.participant, s]));
  expect(byId.marcus.owedCents).toBe(3802);
  expect(byId.jess.owedCents).toBe(3738);
  expect(r.unclaimedCents).toBe(2706);
  expect(r.fullyClaimed).toBe(false);
});

it("handles a bill nobody has claimed yet", () => {           // Review Focus
  const r = splitBill(withUnclaimed(SAIGON, "all"));
  expect(r.claimedSubtotalCents).toBe(0);
  expect(r.fullyClaimed).toBe(false);
  expect(r.shares.every(s => s.owedCents === 0)).toBe(true);
  expect(r.shares.every(s => Number.isInteger(s.owedCents))).toBe(true);
});

it("returns all-zero shares when the bill subtotal is zero rather than dividing", () => {
  const r = splitBill(withItem(oneItem(500, ["a"]), { id: "comp", label: "Comp", cents: -500, claimedBy: ["a"] }));
  expect(r.billSubtotalCents).toBe(0);
  expect(r.shares).toEqual([{ participant: "a", subtotalCents: 0, taxCents: 0, tipCents: 0, owedCents: 0, pardoned: false }]);
});

it("absorbs a pardon into the payer and moves nobody else", () => {
  const base = splitBill(SAIGON);
  const r = splitBill({ ...SAIGON, pardoned: ["lena"] });
  expect(r.shares).toEqual(base.shares.map(s =>
    s.participant === "lena" ? { ...s, pardoned: true } : s));
  expect(r.payerCollectsCents).toBe(base.payerCollectsCents - 3093);
});

it("prorates a negative line item like any other", () => {
  const r = splitBill(withItem(SAIGON, { id: "comp", label: "Comped dessert", cents: -800, claimedBy: ["theo"] }));
  expect(r.shares.reduce((s, x) => s + x.owedCents, 0)).toBe(r.distributableCents);
  expect(r.shares.every(s => s.owedCents >= 0)).toBe(true);
});

it("accepts a zero tip and rejects a negative one", () => {
  expect(splitBill({ ...SAIGON, tipCents: 0 }).distributableCents).toBe(27382);
  expect(() => splitBill({ ...SAIGON, tipCents: -100 })).toThrow();
});

describe("on 1,000 generated bills", () => {
  // Discord snowflakes are numeric strings of varying length, so ids sort by
  // code unit rather than numerically. Generating them that way keeps the
  // tie-break honest.
  function snowflake(random: () => number): ParticipantId {
    let id = String(randomInt(random, 1, 9));
    for (let n = randomInt(random, 16, 18); n > 0; n--) id += String(randomInt(random, 0, 9));
    return id;
  }

  function generateBill(random: () => number): BillInput {
    const participants = [...new Set(Array.from({ length: randomInt(random, 1, 10) }, () => snowflake(random)))];
    const claimSet = () => shuffle(participants, random).slice(0, randomInt(random, 1, participants.length));
    const leaveSomeUnclaimed = random() < 0.3;

    const items: LineItem[] = [];
    let positiveCents = 0;
    for (let i = randomInt(random, 1, 15); i > 0; i--) {
      const cents = randomInt(random, 1, 20000);
      positiveCents += cents;
      items.push({ id: `item${i}`, label: "Dish", cents, claimedBy: claimSet() });
    }
    // Discounts stay below the food total so the bill subtotal stays positive.
    if (random() < 0.3) {
      items.push({ id: "comp", label: "Comp", cents: -randomInt(random, 1, Math.floor(positiveCents / 2)), claimedBy: claimSet() });
    }
    if (leaveSomeUnclaimed) {
      for (const item of items) if (random() < 0.4) item.claimedBy = [];
    }

    return {
      items,
      taxCents: randomInt(random, 0, 3000),
      tipCents: randomInt(random, 0, 6000),
      payer: participants[randomInt(random, 0, participants.length - 1)],
      participants,
      pardoned: participants.filter(() => random() < 0.2),
    };
  }

  const seeds = Array.from({ length: 1000 }, (_, i) => i + 1);

  it("keeps every cent accounted for, every column summed, and claim order irrelevant", () => {
    for (const seed of seeds) {
      const random = seededRandom(seed);
      const bill = generateBill(random);
      const r = splitBill(bill);
      const why = `seed ${seed}`;
      const owedTotal = r.shares.reduce((s, x) => s + x.owedCents, 0);

      expect(owedTotal + r.unclaimedCents, why).toBe(r.distributableCents);
      if (r.fullyClaimed) {
        expect(owedTotal, why).toBe(r.distributableCents);
        expect(r.unclaimedCents, why).toBe(0);
      }
      for (const s of r.shares) {
        expect(Number.isInteger(s.owedCents), why).toBe(true);
        expect(s.subtotalCents + s.taxCents + s.tipCents, why).toBe(s.owedCents);
      }
      if (bill.items.every((item) => item.cents >= 0)) {
        expect(r.shares.every((s) => s.owedCents >= 0), why).toBe(true);
      }
      expect(splitBill(shuffleClaims(bill, random)), why).toEqual(r);
    }
  });
});
