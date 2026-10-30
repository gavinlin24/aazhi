import { Script, runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../../src/web/client";
import { PROFILE_SCRIPT } from "../../src/web/profile-client";

// Lifts named top-level helpers out of the page script, which only runs
// against a live page, so their logic can be checked on its own. The match
// leans on the script's two-space indent: a reshaped helper fails loudly here
// rather than passing silently.
function lift<T>(names: string[], page: Record<string, unknown> = {}): T {
  const source = names.map((name) => {
    const found = new RegExp(`\\n  function ${name}\\([^]*?\\n  }\\n`).exec(CLIENT_SCRIPT);
    if (!found) throw new Error(`no helper named ${name} in the page script`);
    return found[0];
  });
  return runInNewContext(`${source.join("")}({ ${names.join(", ")} })`, page) as T;
}

const helpers = <T>(...names: string[]): T => lift<T>(names);

// The page script is a string no compiler ever reads, so a syntax slip in it
// would pass every other test and deploy. workerd refuses to compile code
// from a string, so this check runs under Node instead.
describe("the page script", () => {
  it("parses as a browser script", () => {
    expect(() => new Script(CLIENT_SCRIPT, { filename: "client.js" })).not.toThrow();
  });

  it("includes the profile script, which has the same trap", () => {
    expect(() => new Script(PROFILE_SCRIPT, { filename: "profile.js" })).not.toThrow();
    expect(PROFILE_SCRIPT).not.toContain("</script");
  });

});

// Every open page polls, and a bill confirmed elsewhere changes nothing on this
// bill but its answer to "is the receipt taken". The redraw has to notice that.
describe("the actions card on an open page", () => {
  const card = { _key: "", draws: 0, contains: () => false, replaceChildren() { this.draws += 1; } };
  const { renderActions } = lift<{ renderActions: (v: unknown) => void }>(
    ["renderActions", "keyedInto", "confirmBlock", "logBlock", "logSpent"],
    {
      root: { querySelector: () => card },
      busy: new Set(),
      armed: new Set(),
      editingPrinted: () => false,
      stopped: false,
      logGone: null,
      actionNodes: () => [],
      document: { activeElement: null },
    },
  );
  const ready = {
    status: "draft",
    printedTotalCents: 2000,
    reconciles: { ok: true },
    items: [{ claimedBy: ["gavin"] }],
    participants: [],
    payerId: "gavin",
    hasSplitPartner: true,
    receiptTaken: false,
  };

  it("redraws when the receipt is taken by another bill", () => {
    renderActions({ s: ready });
    renderActions({ s: ready });
    expect(card.draws).toBe(1);
    renderActions({ s: { ...ready, receiptTaken: true } });
    expect(card.draws).toBe(2);
  });

  // A tick shows at once, but what it comes to arrives with the server's answer,
  // when the items no longer change. That answer is what turns on Log it.
  it("redraws a log when the amount picked lands", () => {
    const picking = { ...ready, kind: "log", viewer: "gavin", place: "Saigon Kitchen", result: { shares: [] } };
    renderActions({ s: picking });
    const before = card.draws;
    renderActions({ s: { ...picking, result: { shares: [{ participant: "gavin", owedCents: 1000 }] } } });
    expect(card.draws).toBe(before + 1);
  });
});

describe("the Confirm button's reason for waiting", () => {
  const { confirmBlock } = helpers<{ confirmBlock: (s: unknown) => string | null }>("confirmBlock");
  const gavin = { id: "gavin", kind: "member" };
  const ready = { printedTotalCents: 2000, reconciles: { ok: true }, items: [{ claimedBy: ["gavin"] }], hasSplitPartner: true, payerId: "gavin", participants: [gavin] };

  it("waits for someone to split with, and matches the page", () => {
    expect(confirmBlock({ ...ready, hasSplitPartner: false })).toBe("Add someone, or use /log.");
    expect(confirmBlock(ready)).toBeNull();
  });

  it("asks for a claim once another member has joined, and matches the page", () => {
    const joined = { ...ready, hasSplitPartner: false, participants: [gavin, { id: "marcus", kind: "member" }] };
    expect(confirmBlock(joined)).toBe("Someone else needs to claim an item.");
  });

  it("still asks for someone when the only other person is a guest", () => {
    const guestOnly = { ...ready, hasSplitPartner: false, participants: [gavin, { id: "sam", kind: "guest" }] };
    expect(confirmBlock(guestOnly)).toBe("Add someone, or use /log.");
  });

  it("puts a receipt already split ahead of everything, since nothing else can help", () => {
    const taken = { ...ready, receiptTaken: true, items: [{ claimedBy: [] }], hasSplitPartner: false };
    expect(confirmBlock(taken)).toBe("This receipt was already split.");
  });

  it("says nobody has claimed first, since that's the earlier step", () => {
    expect(confirmBlock({ ...ready, items: [{ claimedBy: [] }], hasSplitPartner: false })).toBe("Nobody has claimed anything yet.");
  });
});

describe("a price typed into the line editor", () => {
  type Input = { value: string; dataset: { off?: string } };
  const { amountOf, addonPrice } = helpers<{
    amountOf: (input: Input) => string | null;
    addonPrice: (input: Input) => string | null;
  }>("decimal", "hundredths", "amountOf", "addonPrice");
  const charge = (value: string): Input => ({ value, dataset: {} });
  const moneyOff = (value: string): Input => ({ value, dataset: { off: "" } });

  it("reads the server's strict shape out of what a person types", () => {
    expect(amountOf(charge("12"))).toBe("12");
    expect(amountOf(charge("$1,012.50"))).toBe("1012.50");
    expect(amountOf(charge(".5"))).toBe("0.5");
  });

  it("keeps money off as money off while the payer retypes the amount, since the number pad has no minus", () => {
    expect(amountOf(moneyOff("5"))).toBe("-5");
    expect(amountOf(moneyOff("4.50"))).toBe("-4.50");
    expect(amountOf(moneyOff("0"))).toBe("0");
    expect(addonPrice(moneyOff("0.75"))).toBe("-0.75");
  });

  it("charges for anything the payer adds, and refuses a typed minus", () => {
    for (const text of ["-5", "-$5.00", "", "$", "12.345", "1e3", "five"]) expect(amountOf(charge(text)), text).toBeNull();
    expect(amountOf(moneyOff("-5"))).toBeNull();
  });

  it("counts an add-on left without a price as unpriced", () => {
    expect(addonPrice(charge(""))).toBe("0.00");
    expect(addonPrice(moneyOff("  "))).toBe("0.00");
    expect(addonPrice(charge("-0.50"))).toBeNull();
  });
});
