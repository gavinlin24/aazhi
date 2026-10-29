import { describe, expect, it, vi } from "vitest";
import { verifyRequest } from "../../src/discord/verify";
import { generateKeypair } from "./helpers";

const BODY = JSON.stringify({ type: 1 });
const TIMESTAMP = "1767225600";
// The clock is pinned to the signing moment, so these tests stay about the
// signature and never age out of the freshness window.
const NOW_MS = Number(TIMESTAMP) * 1000;

describe("verifyRequest", () => {
  it("verifies a signature produced by a known Ed25519 keypair", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS)).toBe(true);
  });

  it("rejects a signature made over a different body", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(JSON.stringify({ type: 2 }), signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS)).toBe(false);
  });

  it("rejects a signature made over a different timestamp", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, "1767225601", keypair.publicKeyHex, NOW_MS)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const signer = await generateKeypair();
    const other = await generateKeypair();
    const signature = await signer.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, other.publicKeyHex, NOW_MS)).toBe(false);
  });

  it("rejects missing signature or timestamp", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, null, TIMESTAMP, keypair.publicKeyHex, NOW_MS)).toBe(false);
    expect(await verifyRequest(BODY, signature, null, keypair.publicKeyHex, NOW_MS)).toBe(false);
  });

  it("returns false, not a throw, for a malformed public key", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, "not-hex-at-all", NOW_MS)).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, "abcd", NOW_MS)).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, "", NOW_MS)).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex.slice(1), NOW_MS)).toBe(false);
  });

  it("returns false, not a throw, for a malformed signature", async () => {
    const keypair = await generateKeypair();

    expect(await verifyRequest(BODY, "zz".repeat(64), TIMESTAMP, keypair.publicKeyHex, NOW_MS)).toBe(false);
    expect(await verifyRequest(BODY, "abcd", TIMESTAMP, keypair.publicKeyHex, NOW_MS)).toBe(false);
    expect(await verifyRequest(BODY, "", TIMESTAMP, keypair.publicKeyHex, NOW_MS)).toBe(false);
  });
});

// A captured request stays validly signed forever, so the timestamp it was
// signed with has to be close to now for the signature to mean anything.
describe("verifyRequest timestamp freshness", () => {
  const SECOND = 1000;

  it("accepts a timestamp up to five minutes either side of now", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    for (const offset of [0, 300, -300]) {
      expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS + offset * SECOND), String(offset)).toBe(true);
    }
  });

  it("rejects a validly signed request more than five minutes old", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS + 301 * SECOND)).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS + 86_400 * SECOND)).toBe(false);
  });

  it("rejects a validly signed request more than five minutes in the future", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS - 301 * SECOND)).toBe(false);
  });

  it("rejects a validly signed timestamp that is not plain epoch-second digits", async () => {
    const keypair = await generateKeypair();

    for (const timestamp of ["1767225600.0", " 1767225600", "1767225600 ", "+1767225600", "-1767225600", "1.7672256e9", "0x6955b900", "", "abc"]) {
      const signature = await keypair.sign(timestamp + BODY);
      expect(await verifyRequest(BODY, signature, timestamp, keypair.publicKeyHex, NOW_MS), JSON.stringify(timestamp)).toBe(false);
    }
    // Milliseconds are digits too, but they are not epoch seconds.
    const millis = String(NOW_MS);
    expect(await verifyRequest(BODY, await keypair.sign(millis + BODY), millis, keypair.publicKeyHex, NOW_MS)).toBe(false);
  });

  it("checks the signature before the clock, so a stale request still costs a verify", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);
    const verify = vi.spyOn(crypto.subtle, "verify");

    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex, NOW_MS + 301 * SECOND)).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });
});
