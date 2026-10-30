import { Script, runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../../src/web/client";
import { PROFILE_SCRIPT } from "../../src/web/profile-client";

// Lifts named top-level helpers out of the page script, which only runs
// against a live page, so their logic can be checked on its own. The match
// leans on the script's two-space indent: a reshaped helper fails loudly here
// rather than passing silently.
function helpers<T>(...names: string[]): T {
  const source = names.map((name) => {
    const found = new RegExp(`\\n  function ${name}\\([^]*?\\n  }\\n`).exec(CLIENT_SCRIPT);
    if (!found) throw new Error(`no helper named ${name} in the page script`);
    return found[0];
  });
  return runInNewContext(`${source.join("")}({ ${names.join(", ")} })`) as T;
}

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
