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

it("a displayed share's lines always sum to its total", () => {
  for (const s of splitBill({ ...SAIGON, discountCents: 1999 }).shares) {
    expect(s.subtotalCents - s.discountCents + s.taxCents + s.tipCents).toBe(s.owedCents);
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

// Each diner owes exactly 100.5 of a 201 total, so one cent decides the tie.
const TIED: BillInput = {
  items: [
    { id: "b-dish", label: "Dish", cents: 100, claimedBy: ["b"] },
    { id: "a-dish", label: "Dish", cents: 100, claimedBy: ["a"] },
  ],
  discountCents: 0,
  taxCents: 1,
  tipCents: 0,
  payer: "b",
  participants: ["b", "a"],
  pardoned: [],
};

it("breaks a largest-remainder tie by the lowest participant id", () => {
  const r = splitBill(TIED);
  expect(r.shares.map(s => [s.participant, s.owedCents])).toEqual([["a", 101], ["b", 100]]);
});

it("never displays a tip line when the bill has no tip", () => {
  // the rounding cent that would make b's tip -1 lands on the tax line instead
  for (const bill of [TIED, { ...SAIGON, tipCents: 0 }]) {
    for (const s of splitBill(bill).shares) {
      expect(s.tipCents).toBe(0);
      expect(s.subtotalCents + s.taxCents).toBe(s.owedCents);
    }
  }
});

it("lets a person whose own lines net negative owe a negative share", () => {
  // b's coupon outweighs b's dish, so b is owed money back; the engine
  // reflects claims as made rather than shifting b's credit onto a
  const r = splitBill({
    items: [
      { id: "dish-a", label: "Dish", cents: 5000, claimedBy: ["a"] },
      { id: "dish-b", label: "Dish", cents: 300, claimedBy: ["b"] },
      { id: "coupon", label: "Coupon", cents: -1000, claimedBy: ["b"] },
    ],
    discountCents: 0,
    taxCents: 400,
    tipCents: 800,
    payer: "a",
    participants: ["a", "b"],
    pardoned: [],
  });
  const byId = Object.fromEntries(r.shares.map(s => [s.participant, s]));
  expect(byId.b.subtotalCents).toBe(-700);
  expect(byId.b.owedCents).toBe(-895);
  expect(byId.a.owedCents).toBe(6395);
  expect(byId.a.owedCents + byId.b.owedCents).toBe(r.distributableCents);
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
  expect(r.shares).toEqual([{ participant: "a", subtotalCents: 0, discountCents: 0, taxCents: 0, tipCents: 0, owedCents: 0, pardoned: false }]);
});

it("absorbs a pardon into the payer and moves nobody else", () => {
  const base = splitBill(SAIGON);
  const r = splitBill({ ...SAIGON, pardoned: ["lena"] });
  expect(r.shares).toEqual(base.shares.map(s =>
    s.participant === "lena" ? { ...s, pardoned: true } : s));
  expect(r.payerCollectsCents).toBe(base.payerCollectsCents - 3093);
});

it("has the payer collect only what claimants owe while lines are unclaimed", () => {
  const r = splitBill({
    items: [
      { id: "a", label: "Dish", cents: 3000, claimedBy: ["bob"] },
      { id: "b", label: "Dish", cents: 7000, claimedBy: [] },
    ],
    discountCents: 0,
    taxCents: 0,
    tipCents: 0,
    payer: "gavin",
    participants: ["gavin", "bob"],
    pardoned: [],
  });
  expect(r.payerCollectsCents).toBe(3000);
});

it("prorates a negative line item like any other", () => {
  const r = splitBill(withItem(SAIGON, { id: "comp", label: "Comped dessert", cents: -800, claimedBy: ["theo"] }));
  expect(r.shares.reduce((s, x) => s + x.owedCents, 0)).toBe(r.distributableCents);
  expect(r.shares.every(s => s.owedCents >= 0)).toBe(true);
});

describe("a whole-bill discount", () => {
  it("comes off the total and is spread by what each person ordered, the way tax is", () => {
    // 10% of the 25150 subtotal.
    const r = splitBill({ ...SAIGON, discountCents: 2515 });
    expect(r.distributableCents).toBe(32412 - 2515);
    expect(r.shares.reduce((n, s) => n + s.owedCents, 0)).toBe(r.distributableCents);
    const byId = Object.fromEntries(r.shares.map(s => [s.participant, s]));
    expect(byId.marcus.subtotalCents).toBe(3450);
    expect(byId.marcus.discountCents).toBe(345);
    expect(byId.marcus.taxCents).toBe(306);
    expect(byId.marcus.owedCents).toBe(4446 - 345);
    expect(byId.lena.subtotalCents).toBe(2400);
    expect(byId.lena.discountCents).toBe(240);
  });

  it("changes nothing when it is zero", () => {
    expect(splitBill({ ...SAIGON, discountCents: 0 })).toEqual(splitBill(SAIGON));
  });

  it("can take the whole subtotal, leaving only tax and tip", () => {
    const r = splitBill({ ...SAIGON, discountCents: 25150 });
    expect(r.distributableCents).toBe(2232 + 5030);
    expect(r.shares.reduce((n, s) => n + s.owedCents, 0)).toBe(2232 + 5030);
    for (const s of r.shares) expect(s.discountCents).toBe(s.subtotalCents);

    const free = splitBill({ ...oneItem(1000, ["a", "b", "c"]), discountCents: 1000 });
    expect(free.shares.map(s => [s.owedCents, s.discountCents])).toEqual([[0, 334], [0, 333], [0, 333]]);
  });

  it("rounds so the shares, and the discount slices, still add up exactly", () => {
    // 100 off three 1000 dishes is 33.33 each: one person takes the extra cent.
    const r = splitBill({
      items: ["a", "b", "c"].map(p => ({ id: p, label: "Dish", cents: 1000, claimedBy: [p] })),
      discountCents: 100,
      taxCents: 0,
      tipCents: 0,
      payer: "a",
      participants: ["a", "b", "c"],
      pardoned: [],
    });
    expect(r.shares.map(s => s.owedCents)).toEqual([967, 967, 966]);
    expect(r.shares.map(s => s.discountCents)).toEqual([33, 33, 34]);
    // No tax or tip on this bill, so neither line may carry the stray cent.
    expect(r.shares.every(s => s.taxCents === 0 && s.tipCents === 0)).toBe(true);
  });

  it("rejects a negative discount", () => {
    expect(() => splitBill({ ...SAIGON, discountCents: -100 })).toThrow(RangeError);
  });
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

    const bill = {
      items,
      taxCents: randomInt(random, 0, 3000),
      // A no-tip bill is common and is where a stray cent could show as a -$0.01 tip.
      tipCents: random() < 0.15 ? 0 : randomInt(random, 0, 6000),
      payer: participants[randomInt(random, 0, participants.length - 1)],
      participants,
      pardoned: participants.filter(() => random() < 0.2),
    };
    // Drawn last so the bills generated before discounts existed stay the same.
    // Up to the whole subtotal, which is as much as the page lets anyone enter.
    const subtotal = items.reduce((n, item) => n + item.cents, 0);
    return { ...bill, discountCents: random() < 0.3 ? randomInt(random, 0, subtotal) : 0 };
  }

  const seeds = Array.from({ length: 1000 }, (_, i) => i + 1);

  it("keeps every cent accounted for, every column summed and honestly signed, and claim order irrelevant", () => {
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
        expect(s.subtotalCents - s.discountCents + s.taxCents + s.tipCents, why).toBe(s.owedCents);
        // A share can only go negative when that person's own lines net negative.
        if (s.subtotalCents >= 0) expect(s.owedCents, why).toBeGreaterThanOrEqual(0);
        if (s.subtotalCents <= 0) expect(s.owedCents, why).toBeLessThanOrEqual(0);
        // The displayed tip never points the opposite way from the exact slice
        // tip * subtotal / billSubtotal, and is zero when that slice is zero.
        const exactTipSign = Math.sign(bill.tipCents) * Math.sign(s.subtotalCents) * Math.sign(r.billSubtotalCents);
        expect(s.tipCents === 0 || Math.sign(s.tipCents) === exactTipSign, why).toBe(true);
        // Nor does the discount, so it never shows as money added.
        const exactDiscountSign = Math.sign(bill.discountCents) * Math.sign(s.subtotalCents) * Math.sign(r.billSubtotalCents);
        expect(s.discountCents === 0 || Math.sign(s.discountCents) === exactDiscountSign, why).toBe(true);
      }
      expect(splitBill(shuffleClaims(bill, random)), why).toEqual(r);
    }
  });
});
