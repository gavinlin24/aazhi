import { clip } from "../discord/notices";
import { formatMonthDay } from "../format";
import type { Cents } from "../money/types";

export const VENMO_RULE = "A Venmo username is 5 to 30 letters, numbers, hyphens or underscores, like @gavin-lin.";

// Venmo's own rule: 5-30 characters, only - and _ beyond letters and numbers.
// Nothing outside this set can reach a link, so a handle can never add a path
// segment, a query parameter or a fragment.
const VENMO = /^[A-Za-z0-9_-]{5,30}$/;

// Returns the username in the form it is stored and linked, or null when it is
// not a valid one.
export function normalizeVenmo(raw: string): string | null {
  const text = raw.trim();
  const name = text.startsWith("@") ? text.slice(1) : text;
  return VENMO.test(name) ? name : null;
}

// "44.46" from 4446 by placing the decimal point in the digit string, so no
// float is ever involved in the amount a friend is asked to send.
function amountString(cents: Cents): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new RangeError(`A payment link needs a positive whole number of cents (got ${cents})`);
  }
  const digits = String(cents).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const MAX_NOTE = 60;

// "Saigon Kitchen 10/28". A Venmo note can be visible to the sender's friends,
// so it says which bill and nothing else: no amounts and no names. The date
// is left off rather than guessed, because a bill's creation time is in UTC and
// reads as tomorrow for an evening dinner in the US. Only the place is clipped,
// so a long name never costs the date.
export function payNote(place: string | null, billDate: string | null): string {
  const date = formatMonthDay(billDate);
  const where = place?.replace(/\s+/g, " ").trim() || "Bill";
  return date ? `${clip(where, MAX_NOTE - date.length - 1)} ${date}` : clip(where, MAX_NOTE);
}

// Both fill in the amount and note, and neither is an app link. The https one
// only reaches the app through a redirect to venmo:// that in-app browsers may
// not follow, so a phone taps the custom scheme directly. It goes nowhere on a
// computer, or on a phone without Venmo, and that is what the https one is for:
// there Venmo shows a sign-in page that keeps the amount and note.
export function payLinks(handle: string, cents: Cents, note: string): { appUrl: string; webUrl: string } {
  if (normalizeVenmo(handle) !== handle) throw new Error("Not a stored Venmo username");
  const user = encodeURIComponent(handle);
  const prefill = `amount=${amountString(cents)}&note=${encodeURIComponent(note)}`;
  return {
    appUrl: `venmo://paycharge?txn=pay&recipients=${user}&${prefill}`,
    webUrl: `https://venmo.com/${user}?txn=pay&${prefill}`,
  };
}
