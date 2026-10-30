import { describe, expect, it } from "vitest";
import { checkMemberProof, mintMemberProof, mintToken, mintViewerToken, readToken, readViewerToken, TOKEN_TTL_MS } from "../../src/web/token";

const KEY = "test-signing-key-generated-for-tests-only";
const NOW = Date.UTC(2026, 9, 28, 20, 0, 0);

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Signs an arbitrary payload with the real key, so a test can hand readToken a
// correctly signed token whose contents are wrong and see that it still refuses.
async function signedWith(payloadJson: string, key = KEY): Promise<string> {
  const payload = base64url(new TextEncoder().encode(payloadJson));
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(sig))}`;
}

describe("access tokens", () => {
  it("round-trips a token", async () => {
    const token = await mintToken("bill-1", "marcus", KEY, NOW);
    expect(await readToken(token, KEY, NOW)).toEqual({ billId: "bill-1", participantId: "marcus" });
    // URL-safe as it stands, so it can ride in a query string unencoded.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("lasts thirty minutes", async () => {
    expect(TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    const token = await mintToken("bill-1", "marcus", KEY, NOW);
    expect(await readToken(token, KEY, NOW + TOKEN_TTL_MS - 1)).not.toBeNull();
  });

  it("refuses an expired token", async () => {
    const token = await mintToken("bill-1", "marcus", KEY, NOW);
    expect(await readToken(token, KEY, NOW + TOKEN_TTL_MS)).toBeNull();
    expect(await readToken(token, KEY, NOW + 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("refuses a token whose payload was edited", async () => {
    const token = await mintToken("bill-1", "marcus", KEY, NOW);
    const [payload, sig] = token.split(".") as [string, string];

    // Marcus tries to become Gavin, keeping his own signature.
    const forged = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const asGavin = base64url(new TextEncoder().encode(JSON.stringify({ ...forged, p: "gavin" })));
    expect(await readToken(`${asGavin}.${sig}`, KEY, NOW)).toBeNull();

    // And a single flipped character anywhere in the payload.
    const i = Math.floor(payload.length / 2);
    const flipped = payload.slice(0, i) + (payload[i] === "A" ? "B" : "A") + payload.slice(i + 1);
    expect(await readToken(`${flipped}.${sig}`, KEY, NOW)).toBeNull();
  });

  it("refuses a token whose signature was edited", async () => {
    const token = await mintToken("bill-1", "marcus", KEY, NOW);
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(await readToken(token.slice(0, -1) + last, KEY, NOW)).toBeNull();
  });

  it("refuses a truncated token", async () => {
    const token = await mintToken("bill-1", "marcus", KEY, NOW);
    const [payload, sig] = token.split(".") as [string, string];
    expect(await readToken(payload, KEY, NOW)).toBeNull();
    expect(await readToken(`${payload}.`, KEY, NOW)).toBeNull();
    expect(await readToken(`${payload}.${sig.slice(0, 20)}`, KEY, NOW)).toBeNull();
    expect(await readToken(token.slice(0, token.length - 10), KEY, NOW)).toBeNull();
  });

  it("refuses a token signed with another key", async () => {
    const token = await mintToken("bill-1", "marcus", "some-other-key", NOW);
    expect(await readToken(token, KEY, NOW)).toBeNull();
  });

  it("refuses garbage without throwing", async () => {
    for (const garbage of ["", ".", "..", "a.b.c", "not a token", "%%%.%%%", "😀.😀", `${"A".repeat(5000)}.x`]) {
      expect(await readToken(garbage, KEY, NOW)).toBeNull();
    }
  });

  it("refuses a correctly signed payload that is not a well-formed grant", async () => {
    const exp = NOW + 60_000;
    const malformed = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ b: "bill-1", p: "marcus" }),
      JSON.stringify({ b: "bill-1", p: "marcus", exp: String(exp) }),
      JSON.stringify({ b: 1, p: "marcus", exp }),
      JSON.stringify({ b: "bill-1", p: null, exp }),
      JSON.stringify({ b: "bill-1", p: "marcus", exp: Number.NaN }),
    ];
    for (const payload of malformed) {
      expect(await readToken(await signedWith(payload), KEY, NOW), payload).toBeNull();
    }
    // The same helper does produce a token readToken accepts, so the refusals
    // above are about the contents and not the helper.
    expect(await readToken(await signedWith(JSON.stringify({ b: "bill-1", p: "marcus", exp })), KEY, NOW)).toEqual({
      billId: "bill-1",
      participantId: "marcus",
    });
  });
});

describe("viewer tokens", () => {
  it("round-trips a viewer and a server, and nothing about who they look at", async () => {
    const token = await mintViewerToken("guild-1", "gavin", "Friday Table", KEY, NOW);
    expect(await readViewerToken(token, KEY, NOW)).toEqual({ guildId: "guild-1", viewerId: "gavin", guildName: "Friday Table" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("works without a server name", async () => {
    const token = await mintViewerToken("guild-1", "gavin", null, KEY, NOW);
    expect(await readViewerToken(token, KEY, NOW)).toEqual({ guildId: "guild-1", viewerId: "gavin", guildName: null });
  });

  it("lasts thirty minutes", async () => {
    const token = await mintViewerToken("guild-1", "gavin", null, KEY, NOW);
    expect(await readViewerToken(token, KEY, NOW + TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(await readViewerToken(token, KEY, NOW + TOKEN_TTL_MS)).toBeNull();
  });

  it("is refused under another key", async () => {
    const token = await mintViewerToken("guild-1", "gavin", null, KEY, NOW);
    expect(await readViewerToken(token, "another-key", NOW)).toBeNull();
  });

  it("cannot be read as a bill token, nor a bill token as a viewer token", async () => {
    const viewer = await mintViewerToken("guild-1", "gavin", null, KEY, NOW);
    const bill = await mintToken("bill-1", "gavin", KEY, NOW);
    expect(await readToken(viewer, KEY, NOW)).toBeNull();
    expect(await readViewerToken(bill, KEY, NOW)).toBeNull();
  });

  it("refuses a signed payload missing a field", async () => {
    const exp = NOW + 1000;
    expect(await readViewerToken(await signedWith(JSON.stringify({ g: "guild-1", exp })), KEY, NOW)).toBeNull();
    expect(await readViewerToken(await signedWith(JSON.stringify({ v: "gavin", exp })), KEY, NOW)).toBeNull();
    expect(await readViewerToken(await signedWith(JSON.stringify({ g: "guild-1", v: "gavin" })), KEY, NOW)).toBeNull();
  });
});

describe("a member proof", () => {
  const viewer = () => mintViewerToken("guild-1", "gavin", null, KEY, NOW);

  it("holds for the person and token it was made for", async () => {
    const token = await viewer();
    expect(await checkMemberProof(await mintMemberProof(token, "theo", KEY), token, "theo", KEY)).toBe(true);
  });

  it("is refused for another person, another token or another key", async () => {
    const token = await viewer();
    const proof = await mintMemberProof(token, "theo", KEY);
    expect(await checkMemberProof(proof, token, "marcus", KEY)).toBe(false);
    expect(await checkMemberProof(proof, await mintViewerToken("guild-1", "marcus", null, KEY, NOW), "theo", KEY)).toBe(false);
    expect(await checkMemberProof(proof, await mintViewerToken("guild-2", "gavin", null, KEY, NOW), "theo", KEY)).toBe(false);
    expect(await checkMemberProof(proof, token, "theo", "another-key")).toBe(false);
  });

  it("refuses text that isn't a signature", async () => {
    const token = await viewer();
    for (const proof of ["", "nonsense", "a b", token]) {
      expect(await checkMemberProof(proof, token, "theo", KEY), proof).toBe(false);
    }
  });
});
