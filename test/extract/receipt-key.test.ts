import { describe, expect, it } from "vitest";
import { logReceiptKey, receiptKey } from "../../src/extract/receipt-key";
import { parsePrintedTime, parseToolInput } from "../../src/extract/schema";

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
  it.each([
    ["6:12 PM", "18:12"],
    ["6:12pm", "18:12"],
    ["06:12 P.M.", "18:12"],
    ["18:12", "18:12"],
    ["18:12:44", "18:12"],
    ["00:30", "00:30"],
    ["12:05 AM", "00:05"],
    ["12:05 PM", "12:05"],
    ["12:05", "12:05"],
    // Restaurants print 7:42 for the evening and 07:42 for the morning.
    ["7:42", "19:42"],
    ["07:42", "07:42"],
  ])("reads %s as %s", (printed, parsed) => {
    expect(parsePrintedTime(printed)).toBe(parsed);
  });

  it.each(["24:15", "25:30", "13:00 PM", "6.12PM", "", null, undefined, 1942])("drops %s without failing the receipt", (printed) => {
    expect(parsePrintedTime(printed)).toBeNull();
  });

  it("reaches the extraction", () => {
    const parsed = parseToolInput({
      is_receipt: true,
      readable: true,
      place: null,
      bill_date: null,
      printed_time: "7:42 PM",
      items: [{ label: "Pho", price: "19.00", confidence: 0.9 }],
      discount: null,
      tax: null,
      printed_total: "19.00",
    });
    expect(parsed.kind === "extraction" && parsed.extraction.billTime).toBe("19:42");
  });
});

describe("the key a log uses", () => {
  const noTime = { billDate: "2026-10-30", billTime: null, printedTotalCents: 1900, items: [{ cents: 1900 }] } as never;
  const timed = { billDate: "2026-10-30", billTime: "19:42", printedTotalCents: 1900, items: [{ cents: 1900 }] } as never;

  it("is the split's key whenever the receipt has one, so a log can find a split of it", async () => {
    expect(await logReceiptKey(timed, "gavin")).toBe(await receiptKey(timed));
  });

  it("falls back to one that only matches the same person on a receipt with no time", async () => {
    expect(await receiptKey(noTime)).toBeNull();
    expect(await logReceiptKey(noTime, "gavin")).toBe(await logReceiptKey(noTime, "gavin"));
    expect(await logReceiptKey(noTime, "gavin")).not.toBe(await logReceiptKey(noTime, "marcus"));
  });
});
