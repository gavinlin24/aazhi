import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantRead,
  MAX_PHOTOS_PER_READ,
  READS_PER_DAY,
  READS_PER_USER_PER_DAY,
  READS_PER_USER_PER_HOUR,
} from "../../src/extract/read-limit";

const db = env.DB;
const USER_LIMIT = "You've read a lot of receipts lately. Try again later.";
const GLOBAL_LIMIT = "Receipt reading is paused until tomorrow.";
const TRY_AGAIN = /try again in a minute/i;
const PHOTO = "https://cdn.discordapp.com/receipt.jpg";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Noon on Oct 30 in Los Angeles, which is on daylight time until Nov 1.
const NOON = Date.UTC(2026, 9, 30, 19);
const MIDNIGHT_AFTER_NOON = Date.UTC(2026, 9, 31, 7);

const photos = (n: number) => Array.from({ length: n }, () => PHOTO);

async function spend(user: string, reads: number, atMs: number): Promise<void> {
  for (let i = 0; i < reads; i++) {
    expect((await grantRead(db, user, [PHOTO], atMs)).ok).toBe(true);
  }
}

async function refusal(user: string, atMs: number, count = 1): Promise<string | null> {
  const grant = await grantRead(db, user, photos(count), atMs);
  return grant.ok ? null : grant.refusal;
}

async function rowCount(): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM receipt_reads").first<{ n: number }>())!.n;
}

// Everyone at once, from people who stay under their own limits.
async function fillGlobalCap(atMs: number): Promise<void> {
  const people = Math.ceil(READS_PER_DAY / READS_PER_USER_PER_HOUR);
  for (let i = 0; i < people; i++) await spend(`crowd-${i}`, READS_PER_USER_PER_HOUR, atMs);
}

beforeEach(async () => {
  await db.prepare("DELETE FROM receipt_reads").run();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the limits", () => {
  it("are the numbers we agreed", () => {
    expect([READS_PER_USER_PER_HOUR, READS_PER_USER_PER_DAY, READS_PER_DAY, MAX_PHOTOS_PER_READ]).toEqual([5, 15, 100, 3]);
  });
});

describe("the hourly limit", () => {
  it("refuses the sixth read and leaves the other reader alone", async () => {
    await spend("gavin", 5, NOON);

    expect(await refusal("gavin", NOON)).toBe(USER_LIMIT);
    expect(await refusal("dani", NOON)).toBeNull();
  });

  it("counts a rolling hour, so a burst can't straddle the top of the clock", async () => {
    await spend("gavin", 5, NOON + 59 * MINUTE);

    expect(await refusal("gavin", NOON + 61 * MINUTE)).toBe(USER_LIMIT);
    expect(await refusal("gavin", NOON + 59 * MINUTE + HOUR - 1)).toBe(USER_LIMIT);
    expect(await refusal("gavin", NOON + 59 * MINUTE + HOUR)).toBeNull();
  });

  it("isn't reset by midnight", async () => {
    await spend("gavin", 5, MIDNIGHT_AFTER_NOON - MINUTE);

    expect(await refusal("gavin", MIDNIGHT_AFTER_NOON)).toBe(USER_LIMIT);
  });

  it("doesn't count a refused read", async () => {
    await spend("gavin", 5, NOON);
    await refusal("gavin", NOON);

    expect(await rowCount()).toBe(5);
  });
});

describe("the daily limit", () => {
  it("refuses the sixteenth read of the day, spread over hours", async () => {
    await spend("gavin", 5, NOON - 3 * HOUR);
    await spend("gavin", 5, NOON - 2 * HOUR);
    await spend("gavin", 5, NOON - HOUR);

    expect(await refusal("gavin", NOON)).toBe(USER_LIMIT);
  });

  it("resets at midnight in Los Angeles, not in UTC", async () => {
    const start = MIDNIGHT_AFTER_NOON - 8 * HOUR;
    await spend("gavin", 5, start);
    await spend("gavin", 5, start + 2 * HOUR);
    await spend("gavin", 5, start + 4 * HOUR);

    // Midnight UTC falls inside the Los Angeles day, and changes nothing.
    expect(await refusal("gavin", Date.UTC(2026, 9, 31, 0, 30))).toBe(USER_LIMIT);
    expect(await refusal("gavin", MIDNIGHT_AFTER_NOON - 1)).toBe(USER_LIMIT);
    expect(await refusal("gavin", MIDNIGHT_AFTER_NOON)).toBeNull();
  });

  it("follows the clock change, when midnight moves an hour later in UTC", async () => {
    // Standard time starts Nov 1, so midnight on Nov 2 is 08:00 UTC, not 07:00.
    const midnight = Date.UTC(2026, 10, 2, 8);
    await spend("gavin", 5, midnight - 5 * HOUR);
    await spend("gavin", 5, midnight - 3 * HOUR);
    await spend("gavin", 5, midnight - 90 * MINUTE);

    expect(await refusal("gavin", midnight - 30 * MINUTE)).toBe(USER_LIMIT);
    expect(await refusal("gavin", midnight)).toBeNull();
  });
});

describe("the global cap", () => {
  it("pauses everyone, including someone with no reads yet", async () => {
    await fillGlobalCap(NOON);

    expect(await refusal("newcomer", NOON)).toBe(GLOBAL_LIMIT);
  });

  it("wins over a person's own limit in the wording, since tomorrow is the true answer", async () => {
    await fillGlobalCap(NOON);

    expect(await refusal("crowd-0", NOON)).toBe(GLOBAL_LIMIT);
  });

  it("lifts at midnight in Los Angeles", async () => {
    await fillGlobalCap(NOON);

    expect(await refusal("newcomer", MIDNIGHT_AFTER_NOON - 1)).toBe(GLOBAL_LIMIT);
    expect(await refusal("newcomer", MIDNIGHT_AFTER_NOON)).toBeNull();
  });
});

describe("several photos", () => {
  it("charges one read per photo", async () => {
    await grantRead(db, "gavin", photos(3), NOON);
    await spend("gavin", 2, NOON);

    expect(await refusal("gavin", NOON)).toBe(USER_LIMIT);
  });

  it("refuses the whole read when it doesn't fit, and charges nothing", async () => {
    await spend("gavin", 4, NOON);

    expect(await refusal("gavin", NOON, 2)).toBe(USER_LIMIT);
    expect(await rowCount()).toBe(4);
    expect(await refusal("gavin", NOON, 1)).toBeNull();
  });

  it("counts photos toward the global cap too", async () => {
    await fillGlobalCap(NOON);
    await db.prepare("DELETE FROM receipt_reads WHERE rowid IN (SELECT rowid FROM receipt_reads LIMIT 2)").run();

    expect(await refusal("newcomer", NOON, 3)).toBe(GLOBAL_LIMIT);
    expect(await refusal("newcomer", NOON, 2)).toBeNull();
  });

  it("refuses more photos than a read can carry, with a reason that can be acted on", async () => {
    const answer = await refusal("gavin", NOON, MAX_PHOTOS_PER_READ + 1);

    expect(answer).toMatch(/up to 3 photos/);
    expect(answer).not.toBe(USER_LIMIT);
    expect(await rowCount()).toBe(0);
  });
});

describe("a retry", () => {
  it("is counted like the call it is, at the same number of photos", async () => {
    const grant = await grantRead(db, "gavin", photos(2), NOON);
    if (!grant.ok) throw new Error(grant.refusal);

    expect(await grant.permit.retry()).toBe(true);
    expect(await refusal("gavin", NOON, 2)).toBe(USER_LIMIT);
    expect(await refusal("gavin", NOON, 1)).toBeNull();
  });

  it("is refused once it no longer fits", async () => {
    await spend("gavin", 4, NOON);
    const grant = await grantRead(db, "gavin", [PHOTO], NOON);
    if (!grant.ok) throw new Error(grant.refusal);

    expect(await grant.permit.retry()).toBe(false);
    expect(await rowCount()).toBe(5);
  });
});

describe("simultaneous commands", () => {
  it("can't slip past one person's limit", async () => {
    const grants = await Promise.all(Array.from({ length: 30 }, () => grantRead(db, "gavin", [PHOTO], NOON)));

    expect(grants.filter((g) => g.ok)).toHaveLength(READS_PER_USER_PER_HOUR);
    expect(await rowCount()).toBe(READS_PER_USER_PER_HOUR);
  });

  it("can't slip past the global cap", async () => {
    const asking = READS_PER_DAY + 40;
    const people = Array.from({ length: asking }, (_, i) => `person-${i}`);
    const grants = await Promise.all(people.map((p) => grantRead(db, p, [PHOTO], NOON)));

    expect(grants.filter((g) => g.ok)).toHaveLength(READS_PER_DAY);
  });
});

describe("a counter that can't answer", () => {
  const hung = {
    prepare: () => ({ bind: () => ({}) }),
    batch: () => new Promise(() => {}),
  } as unknown as D1Database;

  it("refuses the read when the table can't be reached", async () => {
    await db.prepare("ALTER TABLE receipt_reads RENAME TO receipt_reads_away").run();
    try {
      expect(await refusal("gavin", NOON)).toMatch(TRY_AGAIN);
    } finally {
      await db.prepare("ALTER TABLE receipt_reads_away RENAME TO receipt_reads").run();
    }
  });

  it("refuses a retry the same way", async () => {
    const grant = await grantRead(db, "gavin", [PHOTO], NOON);
    if (!grant.ok) throw new Error(grant.refusal);

    await db.prepare("ALTER TABLE receipt_reads RENAME TO receipt_reads_away").run();
    try {
      expect(await grant.permit.retry()).toBe(false);
    } finally {
      await db.prepare("ALTER TABLE receipt_reads_away RENAME TO receipt_reads").run();
    }
  });

  it("gives up in time for Discord's three seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const answer = grantRead(hung, "gavin", [PHOTO], NOON);
    await vi.advanceTimersByTimeAsync(2000);

    expect(await answer).toMatchObject({ ok: false, refusal: expect.stringMatching(TRY_AGAIN) });
  });
});

describe("old rows", () => {
  it("are cleared as new reads come in, so the table can't grow forever", async () => {
    await spend("gavin", 5, NOON);
    await spend("gavin", 5, NOON + HOUR);
    expect(await rowCount()).toBe(10);

    await spend("dani", 1, NOON + 48 * HOUR + 1);

    expect(await rowCount()).toBe(6);
    await spend("dani", 1, NOON + 49 * HOUR + 1);
    expect(await rowCount()).toBe(2);
  });

  it("stays put when nothing is read", async () => {
    await spend("gavin", 5, NOON);
    await refusal("gavin", NOON);

    expect(await rowCount()).toBe(5);
  });
});
