import { describe, expect, it } from "vitest";
import { formatCents, formatDate } from "../src/format";

describe("formatCents", () => {
  it.each([
    [3802, "$38.02"],
    [0, "$0.00"],
    [5, "$0.05"],
    [100, "$1.00"],
    [-800, "-$8.00"],
    [-1, "-$0.01"],
    [123456, "$1,234.56"],
    [100000000, "$1,000,000.00"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });
});

describe("formatDate", () => {
  it("spells out an ISO date", () => {
    expect(formatDate("2026-10-28")).toBe("Oct 28, 2026");
    expect(formatDate("2026-01-05")).toBe("Jan 5, 2026");
  });

  it("gives null for a missing or unreadable date", () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate("28/10/2026")).toBeNull();
    expect(formatDate("2026-13-01")).toBeNull();
  });
});
