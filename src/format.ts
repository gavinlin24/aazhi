import type { Addon, Cents } from "./money/types";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCents(cents: Cents): string {
  const abs = Math.abs(cents);
  const remainder = abs % 100;
  const dollars = String((abs - remainder) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(remainder).padStart(2, "0")}`;
}

// "Extra patty +$3.00, No onions": the short line shown under the dish.
export function formatAddons(addons: Addon[]): string {
  return addons.map((a) => (a.cents === 0 ? a.label : `${a.label} ${a.cents > 0 ? "+" : ""}${formatCents(a.cents)}`)).join(", ");
}

// Spelled out by hand rather than through Intl so the Discord message and the
// page say the same thing whatever locale the runtime happens to carry.
export function formatDate(isoDate: string | null): string | null {
  const match = isoDate ? ISO_DATE.exec(isoDate) : null;
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : null;
}

// "10/28", for a Venmo note, where the year only takes up room.
export function formatMonthDay(isoDate: string | null): string | null {
  const match = isoDate ? ISO_DATE.exec(isoDate) : null;
  if (!match || !MONTHS[Number(match[2]) - 1]) return null;
  return `${Number(match[2])}/${Number(match[3])}`;
}
