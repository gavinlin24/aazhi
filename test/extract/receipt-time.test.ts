import { describe, expect, it } from "vitest";
import { receiptAge, receiptStamp } from "../../src/extract/receipt-time";

// Pacific daylight time is UTC-7 for all of these.
const at = (iso: string) => Date.parse(iso);

describe("how old a receipt is", () => {
  it.each([
    ["at the table", "2026-10-29", "18:12", "2026-10-30T01:15:00Z"],
    ["7:59 later", "2026-10-29", "18:12", "2026-10-30T09:11:00Z"],
    ["8:00 exactly", "2026-10-29", "18:12", "2026-10-30T09:12:00Z"],
    ["11:40pm logged 12:30am", "2026-10-29", "23:40", "2026-10-30T07:30:00Z"],
    ["11:40pm logged 7:39am", "2026-10-29", "23:40", "2026-10-30T14:39:00Z"],
    ["printed 12:30am logged 12:40am", "2026-10-30", "00:30", "2026-10-30T07:40:00Z"],
    ["no time, date today", "2026-10-30", null, "2026-10-30T20:00:00Z"],
    ["year misread by one", "2025-10-29", "18:12", "2026-10-30T02:00:00Z"],
    ["New Year printed 2026 read 2027", "2027-12-31", "23:00", "2027-01-01T08:00:00Z"],
    ["someone east of here at the table", "2026-10-30", "12:00", "2026-10-30T02:00:00Z"],
  ])("takes %s", (_, date, time, now) => {
    expect(receiptAge(date, time, at(now))).toBe("fresh");
  });

  it.each([
    ["8:01 later", "2026-10-29", "18:12", "2026-10-30T09:13:00Z"],
    ["the next morning", "2026-10-29", "18:12", "2026-10-30T16:00:00Z"],
    ["11:40pm logged 7:41am", "2026-10-29", "23:40", "2026-10-30T14:41:00Z"],
    ["a misread day, Oct 29 at 1:10am", "2026-10-29", "01:10", "2026-10-30T02:00:00Z"],
    ["no time, yesterday", "2026-10-29", null, "2026-10-30T20:00:00Z"],
    ["an old receipt", "2019-06-01", "18:12", "2026-10-30T02:00:00Z"],
  ])("refuses %s as too old", (_, date, time, now) => {
    expect(receiptAge(date, time, at(now))).toBe("too-old");
  });

  it.each([
    ["no date", null],
    ["a date that isn't one", "10/29/26"],
    ["a month that doesn't exist", "2026-13-01"],
  ])("finds no date in %s", (_, date) => {
    expect(receiptAge(date, "18:12", at("2026-10-30T02:00:00Z"))).toBe("no-date");
  });

  it.each([
    ["two days ahead", "2026-11-01", "18:12"],
    ["one day ahead at the same time", "2026-10-30", "19:15"],
  ])("won't believe a date %s", (_, date, time) => {
    expect(receiptAge(date, time, at("2026-10-30T02:00:00Z"))).toBe("ahead");
  });

  // Wall clock against wall clock, so the 8 hours follow the clock on the wall
  // the night it changes.
  it("gives 8 hours by the clock on the night the clocks go back", () => {
    expect(receiptAge("2026-10-31", "22:00", at("2026-11-01T13:59:00Z"))).toBe("fresh");
    expect(receiptAge("2026-10-31", "22:00", at("2026-11-01T14:01:00Z"))).toBe("too-old");
  });

  it("gives 8 hours by the clock on the night the clocks go forward", () => {
    expect(receiptAge("2027-03-13", "22:00", at("2027-03-14T12:59:00Z"))).toBe("fresh");
    expect(receiptAge("2027-03-13", "22:00", at("2027-03-14T13:01:00Z"))).toBe("too-old");
  });
});

describe("the stamp in a refusal", () => {
  it("drops the year and reads like the receipt", () => {
    expect(receiptStamp("2026-10-29", "18:12")).toBe("Oct 29, 6:12 PM");
    expect(receiptStamp("2026-10-29", "00:05")).toBe("Oct 29, 12:05 AM");
    expect(receiptStamp("2026-10-29", null)).toBe("Oct 29");
    expect(receiptStamp(null, "18:12")).toBeNull();
  });
});
