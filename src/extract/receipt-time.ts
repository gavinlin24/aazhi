import { formatDate } from "../format";

// One zone for everyone for now. A setting later replaces this one name.
export const RECEIPT_TIME_ZONE = "America/Los_Angeles";

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 8 * HOUR_MS;
// Pacific to the far side of the Pacific Ocean. Printed times are read as
// Pacific wherever the meal was, so anything smaller refuses someone east of
// here at the table.
const MAX_AHEAD_MS = 22 * HOUR_MS;

export type ReceiptAge = "fresh" | "too-old" | "ahead" | "no-date";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Comparing wall clock with wall clock means daylight time needs no offset
// table: the night the clocks change is an hour long or short, and that's all.
function wallClockMs(nowMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(nowMs);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

function judge(printedMs: number, timed: boolean, nowWall: number): ReceiptAge {
  const age = nowWall - printedMs;
  if (age < -MAX_AHEAD_MS) return "ahead";
  if (timed) return age > WINDOW_MS ? "too-old" : "fresh";
  // With no time all that's left to go on is the day.
  return Math.floor(nowWall / (24 * HOUR_MS)) === Math.floor(printedMs / (24 * HOUR_MS)) ? "fresh" : age < 0 ? "ahead" : "too-old";
}

// The time comes from the server and the zone is fixed, so a phone with a wrong
// clock changes nothing and there is nothing for a browser to fake. `billTime`
// is 24-hour HH:MM, already parsed.
export function receiptAge(billDate: string | null, billTime: string | null, nowMs: number): ReceiptAge {
  const match = billDate ? ISO_DATE.exec(billDate) : null;
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) return "no-date";
  const [hours = 0, minutes = 0] = billTime ? billTime.split(":").map(Number) : [];
  const at = (year: number) => Date.UTC(year, month - 1, day, hours, minutes);
  const nowWall = wallClockMs(nowMs, RECEIPT_TIME_ZONE);
  const printed = Number(match[1]);
  const seen = judge(at(printed), billTime !== null, nowWall);
  if (seen === "fresh") return seen;
  // Models misread a year more than anything else on the receipt, so a year off
  // by one with the month and day intact counts as that misread.
  const thisYear = new Date(nowWall).getUTCFullYear();
  const yearsOff = [thisYear - 1, thisYear, thisYear + 1].filter((year) => Math.abs(year - printed) === 1);
  return yearsOff.some((year) => judge(at(year), billTime !== null, nowWall) === "fresh") ? "fresh" : seen;
}

// "Oct 29, 6:12 PM", for the refusals and the page. A receipt is days old at
// most by the time anyone reads this, so the year is only noise.
export function receiptStamp(billDate: string | null, billTime: string | null): string | null {
  const date = formatDate(billDate)?.replace(/, \d{4}$/, "") ?? null;
  if (!date || !billTime) return date;
  const [hours = 0, minutes = 0] = billTime.split(":").map(Number);
  const half = hours < 12 ? "AM" : "PM";
  return `${date}, ${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${half}`;
}
