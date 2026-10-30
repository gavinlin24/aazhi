import { describe, expect, it } from "vitest";
import { receiptKey } from "../../src/extract/receipt-key";
import { parseToolInput } from "../../src/extract/schema";

const receipt = {
  billDate: "2026-10-29",
  billTime: "19:42",
  printedTotalCents: 3150,
  items: [{ cents: 1900 }, { cents: 1100 }],
};
const key = (overrides: Partial<typeof receipt> = {}) => receiptKey({ ...receipt, ...overrides } as Parameters<typeof receiptKey>[0]);

describe("receiptKey", () => {
  it("is the same however the lines were listed", async () => {
    expect(await key({ items: [{ cents: 1100 }, { cents: 1900 }] })).toBe(await key());
  });

  it("changes with the date, the time, the total or any price", async () => {
    const original = await key();
    expect(await key({ billDate: "2026-10-30" })).not.toBe(original);
    expect(await key({ billTime: "19:43" })).not.toBe(original);
    expect(await key({ printedTotalCents: 3151 })).not.toBe(original);
    expect(await key({ items: [{ cents: 1900 }, { cents: 1101 }] })).not.toBe(original);
  });

  it("has no key without a printed date, time or total", async () => {
    expect(await receiptKey({ ...receipt, billDate: null, items: [] })).toBeNull();
    expect(await receiptKey({ ...receipt, billTime: null, items: [] })).toBeNull();
    expect(await receiptKey({ ...receipt, printedTotalCents: null, items: [] })).toBeNull();
  });
});

describe("the printed time", () => {
  const read = (billTime: unknown) => {
    const parsed = parseToolInput({
      is_receipt: true,
      readable: true,
      place: null,
      bill_date: null,
      bill_time: billTime,
      items: [{ label: "Pho", price: "19.00", confidence: 0.9 }],
      discount: null,
      tax: null,
      printed_total: "19.00",
    });
    return parsed.kind === "extraction" ? parsed.extraction.billTime : parsed.kind;
  };

  it("is kept as HH:MM", () => {
    expect(read("19:42")).toBe("19:42");
    expect(read("7:05")).toBe("07:05");
    expect(read("19:42:10")).toBe("19:42");
  });

  it("drops anything else without failing the receipt", () => {
    for (const bad of [null, undefined, "", "7:42 PM", "25:00", "19:61", 1942]) expect(read(bad)).toBeNull();
  });
});
