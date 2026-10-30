import type { Extraction } from "./schema";

// Money and time, never the place name, which reads differently from one photo
// to the next. Prices are sorted because a read can list the lines in any order.
//
// Null without a printed date, time or total. Strangers' receipts can match on
// money alone, the clearest case being one drink at the same price on the same
// day, and refusing an honest receipt is worse than letting one through twice.
export async function receiptKey(e: Pick<Extraction, "billDate" | "billTime" | "printedTotalCents" | "items">): Promise<string | null> {
  if (!e.billDate || !e.billTime || e.printedTotalCents === null) return null;
  return digest([e.billDate, e.billTime, e.printedTotalCents, sortedPrices(e)]);
}

// The same key whenever the receipt has one, so a log finds a split of it. A
// receipt with no printed time has none, for the reason above, but one person
// logging the same no-time receipt twice is no stranger's coincidence: their id
// goes in the hash, so it only ever matches their own.
export async function logReceiptKey(
  e: Pick<Extraction, "billDate" | "billTime" | "printedTotalCents" | "items">,
  payerId: string,
): Promise<string> {
  return (await receiptKey(e)) ?? digest([payerId, e.billDate, e.printedTotalCents, sortedPrices(e)]);
}

function sortedPrices(e: Pick<Extraction, "items">): string {
  return e.items.map((item) => item.cents).sort((a, b) => a - b).join(",");
}

async function digest(parts: unknown[]): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
