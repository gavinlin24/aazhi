// Every receipt read spends Anthropic credits, so a read has to get past here
// first. A photo is the unit, not a command: photos are what Claude bills for,
// so a three-page receipt uses three of the person's reads.
export const READS_PER_USER_PER_HOUR = 5;
export const READS_PER_USER_PER_DAY = 15;
export const READS_PER_DAY = 100;

// /split's three page options. Without this a message of ten photos could only
// ever be told to try again later, which would never work.
export const MAX_PHOTOS_PER_READ = 3;

const HOUR_MS = 3_600_000;
// Only the current day and the last hour are ever counted, and a day in Los
// Angeles is at most 25 hours long.
const KEEP_MS = 48 * HOUR_MS;

// The first count runs before the reply to Discord, which allows three seconds.
const COUNT_DEADLINE_MS = 2000;

const USER_LIMIT = "You've read a lot of receipts lately. Try again later.";
const GLOBAL_LIMIT = "Receipt reading is paused until tomorrow.";
const COUNT_FAILED = "I couldn't start reading that just now. Try again in a minute.";
const TOO_MANY_PHOTOS = `I can read up to ${MAX_PHOTOS_PER_READ} photos of a receipt at once. Try again with fewer.`;

const LA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

declare const granted: unique symbol;

// extractReceipt takes only this, so a new caller can't reach Claude without
// going through grantRead: skipping it is a type error, not a code review catch.
export interface ReadPermit {
  readonly imageUrls: string[];
  // A retry is another billed call, so it is counted like one. False means no call.
  retry(): Promise<boolean>;
  readonly [granted]: true;
}

export type ReadGrant = { ok: true; permit: ReadPermit } | { ok: false; refusal: string };

type Counted = "counted" | "user-limit" | "global-limit" | "failed";

// The insert decides for itself, in one statement, so simultaneous commands
// can't each read a count that still has room. The refusal's wording comes
// from the same batch, so it needs no second trip to D1.
async function count(db: D1Database, userId: string, photos: number, nowMs: number): Promise<Counted> {
  const day = LA_DATE.format(nowMs);
  const [insert, , today] = await db.batch([
    db
      .prepare(
        `INSERT INTO receipt_reads (user_id, read_at, day, photos)
         SELECT ?1, ?2, ?3, ?4
         WHERE (SELECT COALESCE(SUM(photos), 0) FROM receipt_reads WHERE day = ?3) + ?4 <= ?5
           AND (SELECT COALESCE(SUM(photos), 0) FROM receipt_reads WHERE user_id = ?1 AND day = ?3) + ?4 <= ?6
           AND (SELECT COALESCE(SUM(photos), 0) FROM receipt_reads WHERE user_id = ?1 AND read_at > ?2 - ?7) + ?4 <= ?8`,
      )
      .bind(userId, nowMs, day, photos, READS_PER_DAY, READS_PER_USER_PER_DAY, HOUR_MS, READS_PER_USER_PER_HOUR),
    db.prepare("DELETE FROM receipt_reads WHERE read_at <= ?").bind(nowMs - KEEP_MS),
    db.prepare("SELECT COALESCE(SUM(photos), 0) AS used FROM receipt_reads WHERE day = ?").bind(day),
  ]);
  if (insert!.meta.changes === 1) return "counted";
  const { used } = today!.results[0] as { used: number };
  return used + photos > READS_PER_DAY ? "global-limit" : "user-limit";
}

// Protecting credits wins: a counter that can't answer means no read. A count
// that lands after the deadline only costs the person one read they never got.
async function countInTime(db: D1Database, userId: string, photos: number, nowMs: number): Promise<Counted> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("read count timed out")), COUNT_DEADLINE_MS);
  });
  try {
    return await Promise.race([count(db, userId, photos, nowMs), deadline]);
  } catch (error) {
    console.error("could not count a receipt read", error);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

// Checked and counted before Claude is called, so a read that fails or gets
// refused afterwards stays counted: it was paid for all the same. `refusal` is
// meant for a private reply. It names no server or person.
export async function grantRead(db: D1Database, userId: string, imageUrls: string[], nowMs: number = Date.now()): Promise<ReadGrant> {
  if (imageUrls.length > MAX_PHOTOS_PER_READ) return { ok: false, refusal: TOO_MANY_PHOTOS };

  const photos = imageUrls.length;
  const counted = await countInTime(db, userId, photos, nowMs);
  if (counted === "user-limit") return { ok: false, refusal: USER_LIMIT };
  if (counted === "global-limit") return { ok: false, refusal: GLOBAL_LIMIT };
  if (counted === "failed") return { ok: false, refusal: COUNT_FAILED };

  const permit = {
    imageUrls,
    retry: async () => (await countInTime(db, userId, photos, nowMs)) === "counted",
  };
  return { ok: true, permit: permit as unknown as ReadPermit };
}
