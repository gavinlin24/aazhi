import { Script, runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../../src/web/client";

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

  it("reads a typed minus on a new line's price as money off", () => {
    const { linePrice } = helpers<{ linePrice: (text: string) => string | null }>("decimal", "hundredths", "linePrice");
    expect(linePrice("-5")).toBe("-5");
    expect(linePrice(" -5.50 ")).toBe("-5.50");
    expect(linePrice("−5")).toBe("-5");
    expect(linePrice("-$1,012.50")).toBe("-1012.50");
    expect(linePrice("12.50")).toBe("12.50");
    expect(linePrice("-0")).toBe("0");
    expect(linePrice("--5")).toBeNull();
    expect(linePrice("-")).toBeNull();
    expect(linePrice("5-")).toBeNull();
  });
});
