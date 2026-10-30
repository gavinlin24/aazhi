import { describe, expect, it } from "vitest";
import { normalizeVenmo, payLinks, payNote } from "../../src/web/paylink";
import { randomInt, seededRandom } from "../fixtures/random";

const NOTE = "Saigon Kitchen 10/28";

// A custom scheme has no standard host, so the query is read off the string.
function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

// The amount string turned back into cents by moving the decimal point, not by
// parsing a float, so the check itself cannot round.
function centsIn(amount: string): number {
  expect(amount).toMatch(/^\d+\.\d{2}$/);
  return Number(amount.replace(".", ""));
}

describe("payLinks", () => {
  it("opens the Venmo app with the recipient, amount and note filled in", () => {
    const { appUrl } = payLinks("gavin-lin", 4446, NOTE);

    expect(appUrl).toBe("venmo://paycharge?txn=pay&recipients=gavin-lin&amount=44.46&note=Saigon%20Kitchen%2010%2F28");
  });

  it("offers the same payment on venmo.com for a computer", () => {
    const url = new URL(payLinks("gavin-lin", 4446, NOTE).webUrl);

    expect(url.origin).toBe("https://venmo.com");
    expect(url.pathname).toBe("/gavin-lin");
    expect(url.searchParams.get("txn")).toBe("pay");
    expect(url.searchParams.get("amount")).toBe("44.46");
    expect(url.searchParams.get("note")).toBe(NOTE);
  });

  it("encodes a note that would otherwise end the query string or add a parameter", () => {
    const { appUrl, webUrl } = payLinks("gavin-lin", 4446, "Fish & chips #2 ?amount=1");

    for (const url of [appUrl, webUrl]) {
      expect(queryOf(url).get("note")).toBe("Fish & chips #2 ?amount=1");
      expect(queryOf(url).getAll("amount")).toEqual(["44.46"]);
      expect(url).not.toContain(" ");
      expect(url).not.toContain("#");
    }
  });

  it("formats every amount from integer cents, never through a float", () => {
    const random = seededRandom(9);
    const amounts = [1, 5, 10, 99, 100, 101, 4446, 32412, 100000, 123456789];
    for (let i = 0; i < 300; i++) amounts.push(randomInt(random, 1, 10_000_000));

    for (const cents of amounts) {
      const { appUrl, webUrl } = payLinks("gavin-lin", cents, NOTE);
      expect(centsIn(queryOf(appUrl).get("amount")!)).toBe(cents);
      expect(centsIn(queryOf(webUrl).get("amount")!)).toBe(cents);
    }
    // 0.1 + 0.2 territory: a float path would print 0.30000000000000004 or 0.29.
    expect(queryOf(payLinks("gavin-lin", 30, NOTE).appUrl).get("amount")).toBe("0.30");
    expect(queryOf(payLinks("gavin-lin", 29, NOTE).appUrl).get("amount")).toBe("0.29");
  });

  it("refuses an amount that is not a positive whole number of cents", () => {
    for (const cents of [0, -100, 44.46, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => payLinks("gavin-lin", cents, NOTE)).toThrow(RangeError);
    }
  });

  it("refuses to build a link from a username that did not pass validation", () => {
    expect(() => payLinks("evil.com/x?", 4446, NOTE)).toThrow();
    expect(() => payLinks("@gavin-lin", 4446, NOTE)).toThrow();
  });
});

describe("payNote", () => {
  it("names the place and the date, and nothing else", () => {
    expect(payNote("Saigon Kitchen", "2026-10-28")).toBe("Saigon Kitchen 10/28");
    expect(payNote("Saigon Kitchen", "2026-01-05")).toBe("Saigon Kitchen 1/5");
  });

  it("falls back to Dinner when the receipt names no place", () => {
    expect(payNote(null, "2026-10-28")).toBe("Dinner 10/28");
    expect(payNote("   ", "2026-10-28")).toBe("Dinner 10/28");
  });

  // Today's date would be a guess: late in a US evening it is already tomorrow in UTC.
  it("leaves the date off rather than guessing one", () => {
    expect(payNote("Saigon Kitchen", null)).toBe("Saigon Kitchen");
    expect(payNote(null, "not a date")).toBe("Dinner");
  });

  it("folds a place that came off the receipt on two lines", () => {
    expect(payNote("Saigon\n  Kitchen ", "2026-10-28")).toBe("Saigon Kitchen 10/28");
  });

  it("keeps the date when a long name is cut, and never cuts an emoji in half", () => {
    const long = payNote("🍜".repeat(80), "2026-10-28");

    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith("… 10/28")).toBe(true);
    expect(() => encodeURIComponent(long)).not.toThrow();
  });
});

describe("normalizeVenmo", () => {
  it("accepts a username in the forms people type it", () => {
    expect(normalizeVenmo("gavin-lin")).toBe("gavin-lin");
    expect(normalizeVenmo(" @Gavin_Lin24 ")).toBe("Gavin_Lin24");
  });

  it("rejects usernames that are malformed or could break out of the link", () => {
    const bad = [
      "",
      "abcd", // under Venmo's five-character minimum
      "a".repeat(31),
      "gavin lin",
      "gavin/../../x",
      "gavin?txn=charge",
      "gavin#frag",
      "gavin%2F",
      "https://evil.example",
      "gavin.lin",
    ];
    for (const handle of bad) expect(normalizeVenmo(handle), JSON.stringify(handle)).toBeNull();
  });
});
