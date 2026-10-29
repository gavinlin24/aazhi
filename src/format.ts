import type { Cents } from "./money/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCents(cents: Cents): string {
  const abs = Math.abs(cents);
  const remainder = abs % 100;
  const dollars = String((abs - remainder) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(remainder).padStart(2, "0")}`;
}

// Spelled out by hand rather than through Intl so the Discord message and the
// page say the same thing whatever locale the runtime happens to carry.
export function formatDate(isoDate: string | null): string | null {
  const match = isoDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate) : null;
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : null;
}
