function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// A signature never expires, so without a bound on the signed timestamp a
// captured request could be replayed forever. Five minutes either way absorbs
// clock skew and Discord's own delivery delay.
const MAX_SKEW_SECONDS = 300;

// Epoch seconds as Discord sends them: digits only, so "1e9", " 12", "12.0"
// and the like are refused rather than coerced by Number().
function isFresh(timestamp: string, nowMs: number): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) && Math.abs(nowMs / 1000 - seconds) <= MAX_SKEW_SECONDS;
}

// Every failure path returns false rather than throwing: a bad header or a
// misconfigured key must surface as a 401, never as a 500 that leaks detail.
// The clock is a parameter so tests can sign at a fixed moment.
export async function verifyRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKey);
  if (!signatureBytes || !keyBytes) return false;

  let signed: boolean;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "Ed25519", false, ["verify"]);
    signed = await crypto.subtle.verify("Ed25519", key, signatureBytes, new TextEncoder().encode(timestamp + rawBody));
  } catch {
    return false;
  }
  // Only a request Discord really signed is worth asking the time of; anything
  // else is refused the same way whatever its timestamp says.
  return signed && isFresh(timestamp, nowMs);
}
