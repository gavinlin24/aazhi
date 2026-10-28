import { env as workerEnv } from "cloudflare:workers";
import type { Env } from "../../src/env";

export interface TestKeypair {
  publicKeyHex: string;
  sign(message: string): Promise<string>;
}

export function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Generated per run so no key material is ever written down in the repo.
export async function generateKeypair(): Promise<TestKeypair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKeyHex = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    publicKeyHex,
    async sign(message) {
      return toHex(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(message)));
    },
  };
}

export function testEnv(publicKeyHex: string): Env {
  return {
    DB: workerEnv.DB,
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_BOT_TOKEN: "unused-in-these-tests",
    DISCORD_APPLICATION_ID: "unused-in-these-tests",
    ANTHROPIC_API_KEY: "unused-in-these-tests",
    TOKEN_SIGNING_KEY: "unused-in-these-tests",
  };
}

export async function signedRequest(keypair: TestKeypair, body: unknown): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://aazhi.test/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": await keypair.sign(timestamp + raw),
      "x-signature-timestamp": timestamp,
    },
    body: raw,
  });
}
