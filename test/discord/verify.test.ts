import { describe, expect, it } from "vitest";
import { verifyRequest } from "../../src/discord/verify";
import { generateKeypair } from "./helpers";

const BODY = JSON.stringify({ type: 1 });
const TIMESTAMP = "1767225600";

describe("verifyRequest", () => {
  it("verifies a signature produced by a known Ed25519 keypair", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex)).toBe(true);
  });

  it("rejects a signature made over a different body", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(JSON.stringify({ type: 2 }), signature, TIMESTAMP, keypair.publicKeyHex)).toBe(false);
  });

  it("rejects a signature made over a different timestamp", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, "1767225601", keypair.publicKeyHex)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const signer = await generateKeypair();
    const other = await generateKeypair();
    const signature = await signer.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, other.publicKeyHex)).toBe(false);
  });

  it("rejects missing signature or timestamp", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, null, TIMESTAMP, keypair.publicKeyHex)).toBe(false);
    expect(await verifyRequest(BODY, signature, null, keypair.publicKeyHex)).toBe(false);
  });

  it("returns false, not a throw, for a malformed public key", async () => {
    const keypair = await generateKeypair();
    const signature = await keypair.sign(TIMESTAMP + BODY);

    expect(await verifyRequest(BODY, signature, TIMESTAMP, "not-hex-at-all")).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, "abcd")).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, "")).toBe(false);
    expect(await verifyRequest(BODY, signature, TIMESTAMP, keypair.publicKeyHex.slice(1))).toBe(false);
  });

  it("returns false, not a throw, for a malformed signature", async () => {
    const keypair = await generateKeypair();

    expect(await verifyRequest(BODY, "zz".repeat(64), TIMESTAMP, keypair.publicKeyHex)).toBe(false);
    expect(await verifyRequest(BODY, "abcd", TIMESTAMP, keypair.publicKeyHex)).toBe(false);
    expect(await verifyRequest(BODY, "", TIMESTAMP, keypair.publicKeyHex)).toBe(false);
  });
});
