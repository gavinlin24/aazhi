import { describe, expect, it } from "vitest";
import { describeHandle, normalizeHandle, payLink } from "../../src/web/paylink";
import { randomInt, seededRandom } from "../fixtures/random";

const NOTE = "Saigon Kitchen, Oct 28, 2026";

function urlOf(result: ReturnType<typeof payLink>): URL {
  expect(result).not.toBeNull();
  return new URL(result!.url);
}

// The amount string turned back into cents by moving the decimal point, not by
// parsing a float, so the check itself cannot round.
function centsIn(amount: string): number {
  expect(amount).toMatch(/^\d+\.\d{2}$/);
  return Number(amount.replace(".", ""));
}

describe("payLink", () => {
  it("prefills a Venmo link with the amount and note", () => {
    const url = urlOf(payLink("venmo", "gavin-lin", 4446, NOTE));

    expect(url.origin).toBe("https://venmo.com");
    expect(url.pathname).toBe("/gavin-lin");
    expect(url.searchParams.get("txn")).toBe("pay");
    expect(url.searchParams.get("amount")).toBe("44.46");
    expect(url.searchParams.get("note")).toBe(NOTE);
    // Encoded, not pasted raw: a space or comma in the note never reaches the URL as-is.
    expect(url.href).not.toContain(" ");
    expect(url.href).toContain("note=Saigon%20Kitchen%2C%20Oct%2028%2C%202026");
  });

  it("encodes a note that would otherwise end the query string or add a parameter", () => {
    const url = urlOf(payLink("venmo", "gavin-lin", 4446, "Fish & chips #2 ?amount=1"));

    expect(url.searchParams.get("note")).toBe("Fish & chips #2 ?amount=1");
    expect(url.searchParams.getAll("amount")).toEqual(["44.46"]);
    expect(url.hash).toBe("");
  });

  it("keeps a Venmo link inside Discord's 512-character button limit however long the note encodes", () => {
    // Each CJK character or emoji is 9 to 12 characters once URL-encoded.
    const notes = ["西贡厨房".repeat(30), "🍜🍲🥢".repeat(20), `${"🍜".repeat(59)}x`];
    for (const note of notes) {
      const result = payLink("venmo", "a".repeat(30), 123456789, note);
      const { url } = result as { url: string };
      expect(url.length).toBeLessThanOrEqual(512);
      const kept = new URL(url).searchParams.get("note")!;
      // Cut on a whole character and marked as cut, never a broken surrogate.
      expect(kept.endsWith("…")).toBe(true);
      expect(note.startsWith(kept.slice(0, -1))).toBe(true);
      expect(kept.length).toBeGreaterThan(1);
      expect(new URL(url).searchParams.get("amount")).toBe("1234567.89");
    }
    // A note that fits is left whole.
    const short = urlOf(payLink("venmo", "gavin-lin", 4446, "西贡厨房"));
    expect(short.searchParams.get("note")).toBe("西贡厨房");
  });

  it("puts the amount in a Cash App link and no note, since the link cannot carry one", () => {
    const url = urlOf(payLink("cashapp", "GavinL", 4446, NOTE));

    expect(url.origin).toBe("https://cash.app");
    expect(url.pathname).toBe("/$GavinL/44.46");
    expect(url.search).toBe("");
  });

  it("has no link for Zelle, since none opens the bank's app with the amount filled in", () => {
    expect(payLink("zelle", "gavin@example.com", 4446, NOTE)).toBeNull();
    expect(payLink("zelle", "5551234567", 4446, NOTE)).toBeNull();
  });

  it("formats every amount from integer cents, never through a float", () => {
    const random = seededRandom(9);
    const amounts = [1, 5, 10, 99, 100, 101, 4446, 32412, 100000, 123456789];
    for (let i = 0; i < 300; i++) amounts.push(randomInt(random, 1, 10_000_000));

    for (const cents of amounts) {
      const venmo = urlOf(payLink("venmo", "gavin-lin", cents, NOTE));
      expect(centsIn(venmo.searchParams.get("amount")!)).toBe(cents);
      const cash = urlOf(payLink("cashapp", "GavinL", cents, NOTE));
      expect(centsIn(cash.pathname.split("/").at(-1)!)).toBe(cents);
    }
    // 0.1 + 0.2 territory: a float path would print 0.30000000000000004 or 0.29.
    expect(urlOf(payLink("venmo", "gavin-lin", 30, NOTE)).searchParams.get("amount")).toBe("0.30");
    expect(urlOf(payLink("venmo", "gavin-lin", 29, NOTE)).searchParams.get("amount")).toBe("0.29");
  });

  it("refuses an amount that is not a positive whole number of cents", () => {
    for (const cents of [0, -100, 44.46, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => payLink("venmo", "gavin-lin", cents, NOTE)).toThrow(RangeError);
    }
  });

  it("refuses to build a link from a handle that did not pass validation", () => {
    expect(() => payLink("venmo", "evil.com/x?", 4446, NOTE)).toThrow();
    expect(() => payLink("cashapp", "a/b", 4446, NOTE)).toThrow();
    expect(() => payLink("zelle", "not a handle", 4446, NOTE)).toThrow();
  });
});

describe("normalizeHandle", () => {
  it("accepts each app's handle in the forms people type it", () => {
    expect(normalizeHandle("venmo", "gavin-lin")).toBe("gavin-lin");
    expect(normalizeHandle("venmo", " @Gavin_Lin24 ")).toBe("Gavin_Lin24");
    expect(normalizeHandle("cashapp", "$GavinL")).toBe("GavinL");
    expect(normalizeHandle("cashapp", "gavin24")).toBe("gavin24");
    expect(normalizeHandle("zelle", "Gavin.Lin+food@Example.com")).toBe("gavin.lin+food@example.com");
    expect(normalizeHandle("zelle", "(555) 123-4567")).toBe("5551234567");
    expect(normalizeHandle("zelle", "+1 555.123.4567")).toBe("5551234567");
  });

  it("rejects handles that are malformed or could break out of the link", () => {
    const bad: [Parameters<typeof normalizeHandle>[0], string][] = [
      ["venmo", ""],
      ["venmo", "abcd"], // under Venmo's five-character minimum
      ["venmo", "a".repeat(31)],
      ["venmo", "gavin lin"],
      ["venmo", "gavin/../../x"],
      ["venmo", "gavin?txn=charge"],
      ["venmo", "gavin#frag"],
      ["venmo", "gavin%2F"],
      ["venmo", "https://evil.example"],
      ["venmo", "gavin.lin"],
      ["cashapp", "$"],
      ["cashapp", "12345"], // a $Cashtag needs a letter
      ["cashapp", "a".repeat(21)],
      ["cashapp", "gavin/1"],
      ["cashapp", "gavin?x=1"],
      ["cashapp", "$$gavin"],
      ["zelle", "gavin"],
      ["zelle", "gavin@"],
      ["zelle", "gavin@example"],
      ["zelle", "gavin lin@example.com"],
      ["zelle", "12345"],
      ["zelle", "555-123-456"],
      ["zelle", "`gavin`@example.com"],
    ];
    for (const [method, handle] of bad) {
      expect(normalizeHandle(method, handle), `${method} ${JSON.stringify(handle)}`).toBeNull();
    }
  });
});

describe("describeHandle", () => {
  it("shows a stored handle the way each app writes it", () => {
    expect(describeHandle("venmo", "gavin-lin")).toBe("@gavin-lin");
    expect(describeHandle("cashapp", "GavinL")).toBe("$GavinL");
    expect(describeHandle("zelle", "gavin@example.com")).toBe("gavin@example.com");
    expect(describeHandle("zelle", "5551234567")).toBe("(555) 123-4567");
  });
});
