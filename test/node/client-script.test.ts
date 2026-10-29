import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../../src/web/client";

// The page script is a string no compiler ever reads, so a syntax slip in it
// would pass every other test and deploy. workerd refuses to compile code
// from a string, so this check runs under Node instead.
describe("the page script", () => {
  it("parses as a browser script", () => {
    expect(() => new Script(CLIENT_SCRIPT, { filename: "client.js" })).not.toThrow();
  });
});
