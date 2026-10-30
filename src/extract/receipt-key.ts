import type { Extraction } from "./schema";

// Money and time, never the place name, which reads differently from one photo
// to the next. Prices are sorted because a read can list the lines in any order.
//
// Null without a printed date, time or total. Strangers' receipts can match on
// money alone, the clearest case being one drink at the same price on the same
// day, and refusing an honest receipt is worse than letting one through twice.
export async function receiptKey(e: Pick<Extraction, "billDate" | "billTime" | "printedTotalCents" | "items">): Promise<string | null> {
  if (!e.billDate || !e.billTime || e.printedTotalCents === null) return null;
  const prices = e.items.map((item) => item.cents).sort((a, b) => a - b);
  const text = [e.billDate, e.billTime, e.printedTotalCents, prices.join(",")].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
