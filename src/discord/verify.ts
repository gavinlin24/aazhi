function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Every failure path returns false rather than throwing: a bad header or a
// misconfigured key must surface as a 401, never as a 500 that leaks detail.
export async function verifyRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKey);
  if (!signatureBytes || !keyBytes) return false;

  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signatureBytes, new TextEncoder().encode(timestamp + rawBody));
  } catch {
    return false;
  }
}
