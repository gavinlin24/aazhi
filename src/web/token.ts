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
async function sign(fields: Record<string, unknown>, key: string): Promise<string> {
  const payload = toBase64url(encoder.encode(JSON.stringify(fields)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), encoder.encode(payload));
  return `${payload}.${toBase64url(new Uint8Array(signature))}`;
}

// Every refusal is the same null, so a caller (and so a visitor) cannot learn
// whether a token failed on its signature, its shape or its age. The signature
// is checked with crypto.subtle.verify, which compares in constant time,
// before the payload is even decoded.
async function verified(token: string, key: string, nowMs: number): Promise<Record<string, unknown> | null> {
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
    const { exp } = grant as Record<string, unknown>;
    if (typeof exp !== "number" || !Number.isFinite(exp) || nowMs >= exp) return null;
    return grant as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function mintToken(billId: string, participantId: ParticipantId, key: string, nowMs: number): Promise<string> {
  return sign({ b: billId, p: participantId, exp: nowMs + TOKEN_TTL_MS }, key);
}

export async function readToken(
  token: string,
  key: string,
  nowMs: number,
): Promise<{ billId: string; participantId: ParticipantId } | null> {
  const grant = await verified(token, key, nowMs);
  if (!grant) return null;
  const { b, p } = grant;
  return typeof b === "string" && typeof p === "string" ? { billId: b, participantId: p } : null;
}

// A pass to one server's profile pages, walking from person to person, so it
// names the viewer and never the person viewed. Bill tokens and these share a
// key but no field names, so neither reader accepts the other's. The server's
// name rides along because Discord only sends it through a separate call, and
// the page has no reason to make that call on every view.
export async function mintViewerToken(
  guildId: string,
  viewerId: ParticipantId,
  guildName: string | null,
  key: string,
  nowMs: number,
): Promise<string> {
  return sign({ g: guildId, v: viewerId, ...(guildName ? { n: guildName } : {}), exp: nowMs + TOKEN_TTL_MS }, key);
}

export async function readViewerToken(
  token: string,
  key: string,
  nowMs: number,
): Promise<{ guildId: string; viewerId: ParticipantId; guildName: string | null } | null> {
  const grant = await verified(token, key, nowMs);
  if (!grant) return null;
  const { g, v, n } = grant;
  if (typeof g !== "string" || typeof v !== "string") return null;
  return { guildId: g, viewerId: v, guildName: typeof n === "string" ? n : null };
}
