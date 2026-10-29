import type { ParticipantId } from "../money/types";

export const TOKEN_TTL_MS = 30 * 60 * 1000;

const encoder = new TextEncoder();

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Strict about the alphabet because atob quietly skips whitespace and accepts
// "+" and "/", and a reader that tolerates several spellings of one token is
// harder to reason about than one that accepts exactly what mintToken writes.
function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hmacKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

// The signature covers the encoded payload text, not re-serialised JSON, so
// what is verified is byte for byte what arrived.
export async function mintToken(billId: string, participantId: ParticipantId, key: string, nowMs: number): Promise<string> {
  const payload = toBase64url(encoder.encode(JSON.stringify({ b: billId, p: participantId, exp: nowMs + TOKEN_TTL_MS })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), encoder.encode(payload));
  return `${payload}.${toBase64url(new Uint8Array(signature))}`;
}

// Every refusal is the same null, so a caller (and so a visitor) cannot learn
// whether a token failed on its signature, its shape or its age. The signature
// is checked with crypto.subtle.verify, which compares in constant time,
// before the payload is even decoded.
export async function readToken(
  token: string,
  key: string,
  nowMs: number,
): Promise<{ billId: string; participantId: ParticipantId } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts as [string, string];
    const payloadBytes = fromBase64url(payload);
    const signatureBytes = fromBase64url(signature);
    if (!payloadBytes || !signatureBytes) return null;
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), signatureBytes, encoder.encode(payload)))) {
      return null;
    }

    const grant: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes));
    if (typeof grant !== "object" || grant === null) return null;
    const { b, p, exp } = grant as Record<string, unknown>;
    if (typeof b !== "string" || typeof p !== "string" || typeof exp !== "number" || !Number.isFinite(exp)) return null;
    if (nowMs >= exp) return null;
    return { billId: b, participantId: p };
  } catch {
    return null;
  }
}
